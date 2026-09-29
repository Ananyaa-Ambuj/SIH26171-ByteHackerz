import {
    Florence2ForConditionalGeneration,
    AutoProcessor,
    AutoTokenizer,
    RawImage,
} from '@huggingface/transformers';

let model = null;
let processor = null;
let tokenizer = null;

// Regex patterns for text PII
const PII_PATTERNS = {
    // Allows optional spaces/dashes between digits
    aadhaar: /\d{4}[\s-]?\d{4}[\s-]?\d{4}/,
    // PAN: 5 letters, 4 digits, 1 letter (case insensitive)
    pan: /[A-Z]{5}[0-9O]{4}[A-Z]/i,
    // Phone: 10 digits
    phone: /(?:[6-9]\d{9})/,
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

async function loadModel() {
    const model_id = 'onnx-community/Florence-2-large-ft';

    self.postMessage({ type: 'STATUS', message: 'Loading Florence-2 on WebGPU...' });

    try {
        model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
            dtype: 'fp32',
            device: 'webgpu',
            progress_callback: (progress) => {
                self.postMessage({ type: 'PROGRESS', progress });
            },
        });

        processor = await AutoProcessor.from_pretrained(model_id);
        tokenizer = await AutoTokenizer.from_pretrained(model_id);

        self.postMessage({ type: 'MODEL_READY' });
    } catch (err) {
        self.postMessage({ type: 'STATUS', message: `WebGPU unavailable (${err.message}). Falling back to WASM...` });

        model = await Florence2ForConditionalGeneration.from_pretrained(model_id, {
            dtype: 'q4',
            device: 'wasm',
        });
        processor = await AutoProcessor.from_pretrained(model_id);
        tokenizer = await AutoTokenizer.from_pretrained(model_id);

        self.postMessage({ type: 'MODEL_READY' });
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
            if (lower.includes('face') || lower.includes('person') || lower.includes('head') || lower.includes('woman') || lower.includes('man')) {
                rawFaces.push(extractBox(odBoxes[idx]));
            }
        });
    }

    // Merge overlapping face boxes so we get ONE clean box
    if (rawFaces.length > 0) {
        // Find outer bounding box that covers all detected facial parts
        const minX = Math.min(...rawFaces.map(f => f.x));
        const minY = Math.min(...rawFaces.map(f => f.y));
        const maxX = Math.max(...rawFaces.map(f => f.x + f.w));
        const maxY = Math.max(...rawFaces.map(f => f.y + f.h));

        regions.push({
            type: 'face',
            source: 'florence_od',
            method: 'gaussian_blur',
            confidence: 0.95,
            bbox: {
                x: Math.round(minX),
                y: Math.round(minY),
                w: Math.round(maxX - minX),
                h: Math.round(maxY - minY),
            },
        });
    }

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

    console.log('[Florence OCR Raw Output]:', ocrData);

    if (ocrData && ocrBoxes && ocrData.labels) {
        ocrData.labels.forEach((text, idx) => {
            const piiTypes = matchPII(text);
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
    const { type, imageDataUrl } = e.data;

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
                regions,
                latencyMs: elapsedMs,
            });
        } catch (err) {
            self.postMessage({ type: 'ERROR', error: err.message });
        }
    }
});
