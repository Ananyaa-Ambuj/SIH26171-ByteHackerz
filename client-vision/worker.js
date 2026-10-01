import {
    env,
    Florence2ForConditionalGeneration,
    AutoProcessor,
    AutoTokenizer,
    RawImage,
} from '@huggingface/transformers';

// Load ONNX Runtime's WebGPU/WASM runtime from the files copied next to this bundle by
// copy-ort-runtime.mjs. By default transformers.js imports it from the jsdelivr CDN through a
// blob: URL, which the extension CSP (script-src 'self') blocks -- killing WebGPU *and* the
// WASM fallback, since ONNX Runtime refuses to re-initialize after a failed first attempt.
env.backends.onnx.wasm.wasmPaths = new URL('./', import.meta.url).href;

let model = null;
let processor = null;
let tokenizer = null;

// Regex patterns for text PII
const PII_PATTERNS = {
    // Allows optional spaces/dashes between digits
    aadhaar: /\d{4}[\s-]?\d{4}[\s-]?\d{4}/,
    // PAN: 5 letters, 4 digits, 1 letter (case insensitive)
    pan: /[A-Z]{5}[0-9O]{4}[A-Z]/i,
    // Phone: 10 digits, optionally written as 5+5 (e.g. "98765 43210")
    phone: /[6-9]\d{4}[\s-]?\d{5}/,
    // Email
    email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
};

function matchPII(text) {
    const matches = [];
    for (const [type, regex] of Object.entries(PII_PATTERNS)) {
        if (regex.test(text)) {
            matches.push(type);
        }
    }
    return matches.length > 0 ? matches : null;
}

// Labels that mark an OCR line as PII even when OCR garbles the value itself, e.g. "PAN Card: ABCDE123RF"
// (a 4 misread as R) or "Aadhaar No: 9876432 1098" (a dropped digit) slip past the strict patterns above
const PII_LABELS = {
    aadhaar: /aadha?ar|adhaa?r/i,
    pan: /\bPAN\b/,
    phone: /phone|mobile/i,
    email: /e-?mail/i,
};

function matchLabeledPII(text) {
    // Only when the line also holds a value-looking token (3+ digits, or an '@'), so bare field
    // labels such as "PAN Number" stay readable for the agent
    const hasValue = (text.match(/[A-Za-z0-9@._-]{6,}/g) || [])
        .some((token) => token.includes('@') || (token.match(/\d/g) || []).length >= 3);
    if (!hasValue) return null;
    const matches = Object.keys(PII_LABELS).filter((type) => PII_LABELS[type].test(text));
    return matches.length > 0 ? matches : null;
}

// Repeatedly replaces any two intersecting {x, y, w, h} boxes with their bounding union until none intersect
function mergeOverlappingBoxes(boxes) {
    const merged = boxes.map((b) => ({ ...b }));
    let changed = true;
    while (changed) {
        changed = false;
        // Rescan from the start after every merge: the grown union can reach boxes already checked
        for (let i = 0; i < merged.length && !changed; i++) {
            for (let j = i + 1; j < merged.length && !changed; j++) {
                const a = merged[i];
                const b = merged[j];
                if (a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h) {
                    const x = Math.min(a.x, b.x);
                    const y = Math.min(a.y, b.y);
                    merged[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
                    merged.splice(j, 1);
                    changed = true;
                }
            }
        }
    }
    return merged;
}

async function loadModel() {
    const model_id = 'onnx-community/Florence-2-base-ft';

    self.postMessage({ type: 'STATUS', message: 'Loading Florence-2 on WebGPU...' });

    try {
        model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
            // Per-module precision recommended for Florence-2 on WebGPU (transformers.js dtypes guide):
            // the encoders are sensitive to quantization; fp16/q4 keeps download and VRAM small
            // (full fp32 is ~1 GB for base-ft and ~3.1 GB for large-ft, too much for a 4 GB GPU).
            dtype: {
                embed_tokens: 'fp16',
                vision_encoder: 'fp16',
                encoder_model: 'q4',
                decoder_model_merged: 'q4',
            },
            device: 'webgpu',
            progress_callback: (progress) => {
                self.postMessage({ type: 'PROGRESS', progress });
            },
        });

        processor = await AutoProcessor.from_pretrained(model_id);
        tokenizer = await AutoTokenizer.from_pretrained(model_id);

        self.postMessage({ type: 'MODEL_READY', device: 'webgpu' });
    } catch (err) {
        self.postMessage({ type: 'STATUS', message: `WebGPU unavailable (${err.message}). Falling back to WASM...` });

        try {
            model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
                dtype: 'q4',
                device: 'wasm',
                progress_callback: (progress) => {
                    self.postMessage({ type: 'PROGRESS', progress });
                },
            });
            processor = await AutoProcessor.from_pretrained(model_id);
            tokenizer = await AutoTokenizer.from_pretrained(model_id);

            self.postMessage({ type: 'MODEL_READY', device: 'wasm' });
        } catch (wasmErr) {
            self.postMessage({ type: 'ERROR', error: `WASM fallback failed: ${wasmErr.message}` });
        }
    }
}

async function detectPII(imageDataUrl) {
    if (!model || !processor) {
        throw new Error('Florence-2 model is not loaded yet');
    }

    const image = await RawImage.fromURL(imageDataUrl);
    const regions = [];

    // Helper to normalize boxes (whether 4-point bbox or 8-point quad_box)
    function extractBox(box) {
        if (!box) return { x: 0, y: 0, w: 0, h: 0 };
        if (box.length === 8) {
            const xs = [box[0], box[2], box[4], box[6]];
            const ys = [box[1], box[3], box[5], box[7]];
            const minX = Math.min(...xs);
            const maxX = Math.max(...xs);
            const minY = Math.min(...ys);
            const maxY = Math.max(...ys);
            return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
        }
        return { x: box[0], y: box[1], w: box[2] - box[0], h: box[3] - box[1] };
    }

    // -----------------------------------------------------------------
    // Task A: Object Detection (<OD>) — Detect faces & merge overlaps
    // -----------------------------------------------------------------
    const odTask = '<OD>';
    const odPrompts = processor.construct_prompts(odTask);
    const odInputs = await processor(image, odPrompts);
    const odOutput = await model.generate({ ...odInputs, max_new_tokens: 256 });
    const odText = processor.batch_decode(odOutput, { skip_special_tokens: false })[0];
    const odParsed = processor.post_process_generation(odText, odTask, image.size);
    const odData = odParsed[odTask] || odParsed;
    const odBoxes = odData?.bboxes || odData?.quad_boxes;

    const rawFaces = [];
    if (odData && odBoxes && odData.labels) {
        odData.labels.forEach((label, idx) => {
            const lower = label.toLowerCase();
            if (lower.includes('face') || lower.includes('person') || lower.includes('head') || lower.includes('woman') || lower.includes('man') ||
                lower.includes('boy') || lower.includes('girl') || lower.includes('child')) {
                rawFaces.push(extractBox(odBoxes[idx]));
            }
        });
    }

    // Merge overlapping face-part boxes (eyes, head, person) into ONE clean box per person.
    // Boxes that don't overlap stay separate, so two people far apart don't blur everything between them.
    mergeOverlappingBoxes(rawFaces).forEach((face) => {
        regions.push({
            type: 'face',
            source: 'florence_od',
            method: 'gaussian_blur',
            confidence: 0.95,
            bbox: {
                x: Math.round(face.x),
                y: Math.round(face.y),
                w: Math.round(face.w),
                h: Math.round(face.h),
            },
        });
    });

    // -----------------------------------------------------------------
    // Task B: OCR with Region (<OCR_WITH_REGION>) — Text PII
    // -----------------------------------------------------------------
    const ocrTask = '<OCR_WITH_REGION>';
    const ocrPrompts = processor.construct_prompts(ocrTask);
    const ocrInputs = await processor(image, ocrPrompts);
    const ocrOutput = await model.generate({ ...ocrInputs, max_new_tokens: 512 });
    const ocrText = processor.batch_decode(ocrOutput, { skip_special_tokens: false })[0];
    const ocrParsed = processor.post_process_generation(ocrText, ocrTask, image.size);
    const ocrData = ocrParsed[ocrTask] || ocrParsed;
    const ocrBoxes = ocrData?.quad_boxes || ocrData?.bboxes;

    // Never log ocrData: it holds every recognised line, PII included
    if (ocrData && ocrBoxes && ocrData.labels) {
        ocrData.labels.forEach((text, idx) => {
            const piiTypes = matchPII(text) || matchLabeledPII(text);
            if (piiTypes) {
                const b = extractBox(ocrBoxes[idx]);
                regions.push({
                    type: piiTypes.join(', '),
                    types: piiTypes,
                    source: 'florence_ocr',
                    method: 'black_box',
                    confidence: 0.85,
                    text_snippet: text,
                    bbox: {
                        x: Math.round(b.x),
                        y: Math.round(b.y),
                        w: Math.round(b.w),
                        h: Math.round(b.h),
                    },
                });
            }
        });
    }

    return regions;
}

// Worker Message Listener — Interface to Extension / Webpage
self.addEventListener('message', async (e) => {
    // requestId is echoed back so the caller can match replies when detections overlap
    const { type, imageDataUrl, requestId } = e.data;

    if (type === 'LOAD_MODEL') {
        try {
            await loadModel();
        } catch (err) {
            self.postMessage({ type: 'ERROR', error: err.message });
        }
    }

    if (type === 'DETECT') {
        try {
            const startTime = performance.now();
            const regions = await detectPII(imageDataUrl);
            const elapsedMs = Math.round(performance.now() - startTime);

            self.postMessage({
                type: 'RESULTS',
                requestId,
                regions,
                latencyMs: elapsedMs,
            });
        } catch (err) {
            self.postMessage({ type: 'ERROR', requestId, error: err.message });
        }
    }
});
