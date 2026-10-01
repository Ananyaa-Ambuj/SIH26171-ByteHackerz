import {
    env,
    Florence2ForConditionalGeneration,
    AutoProcessor,
    AutoTokenizer,
    RawImage,
} from '@huggingface/transformers';
import { classifyLine, mergeOverlappingBoxes } from './ocr-pii.js';

// Load ONNX Runtime's WebGPU/WASM runtime from the files copied next to this bundle by
// copy-ort-runtime.mjs. By default transformers.js imports it from the jsdelivr CDN through a
// blob: URL, which the extension CSP (script-src 'self') blocks -- killing WebGPU *and* the
// WASM fallback, since ONNX Runtime refuses to re-initialize after a failed first attempt.
env.backends.onnx.wasm.wasmPaths = new URL('./', import.meta.url).href;

let model = null;
let processor = null;
let tokenizer = null;
// The device the loaded model runs on ('webgpu' or 'wasm'), reported with every result
let device = null;

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

        device = 'webgpu';
        self.postMessage({ type: 'MODEL_READY', device });
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

            device = 'wasm';
            self.postMessage({ type: 'MODEL_READY', device });
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
    // Every OCR line that is not PII, box only: the caller can black-box all text where the DOM pass cannot read
    const otherText = [];

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

    // Whole pixels, rounded outwards so no edge of a face or a glyph falls outside the box
    function toIntBox(b) {
        const x = Math.floor(b.x);
        const y = Math.floor(b.y);
        return { x, y, w: Math.ceil(b.x + b.w) - x, h: Math.ceil(b.y + b.h) - y };
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
    // Boxes that don't overlap stay separate, so two people far apart don't get one mask over everything between them.
    // Faces get a solid mask, not a blur (decision D1).
    mergeOverlappingBoxes(rawFaces).forEach((face) => {
        regions.push({ type: 'face', source: 'florence_od', method: 'solid_mask', bbox: toIntBox(face) });
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
            // Results carry boxes and types only, never the recognised text
            const bbox = toIntBox(extractBox(ocrBoxes[idx]));
            const pii = classifyLine(text);
            if (pii) {
                regions.push({ type: pii.type, source: 'florence_ocr', method: 'black_box', bbox });
            } else {
                otherText.push({ bbox });
            }
        });
    }

    return { regions, otherText };
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
            const { regions, otherText } = await detectPII(imageDataUrl);
            const elapsedMs = Math.round(performance.now() - startTime);

            self.postMessage({
                type: 'RESULTS',
                requestId,
                latencyMs: elapsedMs,
                device,
                regions,
                otherText,
            });
        } catch (err) {
            self.postMessage({ type: 'ERROR', requestId, error: err.message });
        }
    }
});
