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
    aadhaar: /\b\d{4}\s?\d{4}\s?\d{4}\b/,
    pan: /\b[A-Z]{5}[0-9]{4}[A-Z]\b/i,
    phone: /\b[6-9]\d{9}\b/,
    email: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/,
    credit_card: /\b(?:\d{4}[-\s]?){3}\d{4}\b/,
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
    const model_id = 'onnx-community/Florence-2-base-ft';

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

    // Task A: Object Detection (<OD>) — Detect people for Blurring
    const odPrompt = '<OD>';
    const odInputs = await processor(image, odPrompt);
    const odTokens = tokenizer(odPrompt, { return_tensors: 'pt', padding: true });
    const odOutput = await model.generate({ ...odInputs, ...odTokens, max_new_tokens: 256 });
    const odText = tokenizer.decode(odOutput[0], { skip_special_tokens: false });
    const odParsed = processor.post_process_generation(odText, odPrompt, image.size);
    const odData = odParsed[odPrompt] || odParsed;

    if (odData && odData.bboxes && odData.labels) {
        odData.labels.forEach((label, idx) => {
            const lower = label.toLowerCase();
            // Flag faces or people for Gaussian Blur
            if (lower.includes('face') || lower.includes('person') || lower.includes('head')) {
                const [x1, y1, x2, y2] = odData.bboxes[idx];
                regions.push({
                    type: 'face',
                    source: 'florence_od',
                    method: 'gaussian_blur',
                    confidence: 0.9,
                    bbox: {
                        x: Math.round(x1),
                        y: Math.round(y1),
                        w: Math.round(x2 - x1),
                        h: Math.round(y2 - y1),
                    },
                });
            }
        });
    }

    // Task B: OCR with Region (<OCR_WITH_REGION>) — Text PII for Black-box redaction
    const ocrPrompt = '<OCR_WITH_REGION>';
    const ocrInputs = await processor(image, ocrPrompt);
    const ocrTokens = tokenizer(ocrPrompt, { return_tensors: 'pt', padding: true });
    const ocrOutput = await model.generate({ ...ocrInputs, ...ocrTokens, max_new_tokens: 512 });
    const ocrText = tokenizer.decode(ocrOutput[0], { skip_special_tokens: false });
    const ocrParsed = processor.post_process_generation(ocrText, ocrPrompt, image.size);
    const ocrData = ocrParsed[ocrPrompt] || ocrParsed;

    if (ocrData && ocrData.bboxes && ocrData.labels) {
        ocrData.labels.forEach((text, idx) => {
            const piiTypes = matchPII(text);
            if (piiTypes) {
                const [x1, y1, x2, y2] = ocrData.bboxes[idx];
                regions.push({
                    type: piiTypes.join(', '),
                    types: piiTypes,
                    source: 'florence_ocr',
                    method: 'black_box',
                    confidence: 0.85,
                    text_snippet: text,
                    bbox: {
                        x: Math.round(x1),
                        y: Math.round(y1),
                        w: Math.round(x2 - x1),
                        h: Math.round(y2 - y1),
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
