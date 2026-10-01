import {
    env,
    Florence2ForConditionalGeneration,
    AutoProcessor,
    RawImage,
} from '@huggingface/transformers';
import { classifyLine, mergeOverlappingBoxes } from './ocr-pii.js';

// Load ONNX Runtime's WebGPU/WASM runtime from the files copied next to this bundle by
// copy-ort-runtime.mjs. By default transformers.js imports it from the jsdelivr CDN through a
// blob: URL, which the extension CSP (script-src 'self') blocks -- killing WebGPU *and* the
// WASM fallback, since ONNX Runtime refuses to re-initialize after a failed first attempt.
env.backends.onnx.wasm.wasmPaths = new URL('./', import.meta.url).href;

const MODEL_ID = 'onnx-community/Florence-2-base-ft';

// Per-module precision recommended for Florence-2 on WebGPU (transformers.js dtypes guide):
// the encoders are sensitive to quantization; fp16/q4 keeps download and VRAM small
// (full fp32 weights take twice the bits of fp16 and eight times those of q4).
const WEBGPU_DTYPE = {
    embed_tokens: 'fp16',
    vision_encoder: 'fp16',
    encoder_model: 'q4',
    decoder_model_merged: 'q4',
};

let model = null;
let processor = null;
// The device the loaded model runs on ('webgpu' or 'wasm'), reported with every result
let device = null;
// The load in progress (a promise of true/false), so a repeated LOAD_MODEL never starts a second one
let loading = null;
// Set once WebGPU fails during a detection: every later load goes straight to WASM
let webgpuFailed = false;
// The one WebGPU -> WASM switch after a failed detection, shared by detections that fail together
let wasmSwitch = null;

// Why WebGPU cannot be used in this worker, or null when an adapter is available
async function webgpuUnavailable() {
    if (!navigator.gpu) return 'no navigator.gpu';
    try {
        return (await navigator.gpu.requestAdapter()) ? null : 'no WebGPU adapter';
    } catch (err) {
        return `adapter request failed: ${err.message}`;
    }
}

// Loads the Florence-2 weights on one device and announces it with MODEL_READY
async function loadOn(dev) {
    model = await Florence2ForConditionalGeneration.from_pretrained(MODEL_ID, {
        dtype: dev === 'webgpu' ? WEBGPU_DTYPE : 'q4',
        device: dev,
        progress_callback: (progress) => {
            self.postMessage({ type: 'PROGRESS', progress });
        },
    });
    device = dev;
    self.postMessage({ type: 'MODEL_READY', device });
}

// WebGPU when it is available; WASM when it is missing, fails to load, or already failed during a detection
async function loadModel() {
    const missing = webgpuFailed ? 'it failed during a detection' : await webgpuUnavailable();
    self.postMessage({
        type: 'STATUS',
        message: missing ? `WebGPU not available (${missing}). Loading Florence-2 on WASM...` : 'Loading Florence-2 on WebGPU...',
    });
    // Image preprocessing and the tokenizer, the same for both devices
    processor ??= await AutoProcessor.from_pretrained(MODEL_ID);

    if (!missing) {
        try {
            await loadOn('webgpu');
            return;
        } catch (err) {
            self.postMessage({ type: 'STATUS', message: `WebGPU load failed (${err.message}). Falling back to WASM...` });
        }
    }
    try {
        await loadOn('wasm');
    } catch (err) {
        throw new Error(`WASM load failed: ${err.message}`);
    }
}

// Runs one model load; a failure is reported as a load ERROR (no requestId). Resolves to whether it worked.
function startLoad(load) {
    loading = load()
        .then(() => true, (err) => {
            self.postMessage({ type: 'ERROR', error: err.message });
            return false;
        })
        .finally(() => {
            loading = null;
        });
    return loading;
}

// WebGPU failed during a detection: free the GPU model and load the WASM one, at most once per worker
function switchToWasm(err) {
    wasmSwitch ??= startLoad(async () => {
        webgpuFailed = true;
        self.postMessage({ type: 'STATUS', message: `WebGPU failed during detection (${err.message}). Switching to WASM...` });
        const gpuModel = model;
        model = null;
        device = null;
        // A broken GPU session may fail to release; the switch goes on
        await gpuModel?.dispose().catch(() => {});
        try {
            await loadOn('wasm');
        } catch (wasmErr) {
            throw new Error(`WASM load failed: ${wasmErr.message}`);
        }
    });
    return wasmSwitch;
}

// One detection. If WebGPU fails while running it, switch to WASM and run this image again there.
async function detect(imageDataUrl) {
    // Decoded first, so a bad image is reported as such and never taken for a WebGPU failure
    const image = await RawImage.fromURL(imageDataUrl);
    // A detection that arrives during the switch waits for it instead of failing
    if (wasmSwitch) await wasmSwitch;
    const usedDevice = device;
    try {
        return { device: usedDevice, ...(await detectPII(model, image)) };
    } catch (err) {
        if (usedDevice !== 'webgpu') throw err;
        if (!(await switchToWasm(err))) {
            throw new Error(`WebGPU failed during detection (${err.message}) and WASM could not be loaded`);
        }
        return { device, ...(await detectPII(model, image)) };
    }
}

// Faces and text PII in one decoded image, run on the model m
async function detectPII(m, image) {
    if (!m || !processor) {
        throw new Error('Florence-2 model is not loaded yet');
    }

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
    const odOutput = await m.generate({ ...odInputs, max_new_tokens: 256 });
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
    const ocrOutput = await m.generate({ ...ocrInputs, max_new_tokens: 512 });
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
        // Safe to repeat: answered with MODEL_READY once loaded, ignored while a load runs, retried after a failure
        if (model) {
            self.postMessage({ type: 'MODEL_READY', device });
        } else if (!loading) {
            startLoad(loadModel);
        }
    }

    if (type === 'DETECT') {
        try {
            const startTime = performance.now();
            const { device: usedDevice, regions, otherText } = await detect(imageDataUrl);
            const elapsedMs = Math.round(performance.now() - startTime);

            self.postMessage({
                type: 'RESULTS',
                requestId,
                latencyMs: elapsedMs,
                device: usedDevice,
                regions,
                otherText,
            });
        } catch (err) {
            self.postMessage({ type: 'ERROR', requestId, error: err.message });
        }
    }
});
