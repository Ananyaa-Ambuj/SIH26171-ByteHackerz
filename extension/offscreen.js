// 1. Start Florence-2 Web Worker
const worker = new Worker('florence-worker.bundle.js', { type: 'module' });

// 2. Start pre-loading the model onto WebGPU
worker.postMessage({ type: 'LOAD_MODEL' });

// Final MODEL_READY / load ERROR message, kept so a side panel opened later can ask for it
let modelState = null;
let nextRequestId = 1;

// Real <-> fake values for semantic_mock, kept for the whole agent run so a value keeps the same fake
let masker = new PIIMasker();

// Vision results keyed by a hash of the exact pixels the model looked at: images that did not change
// since an earlier step are not analysed again (screenpipe-style frame deduplication)
const visionCache = new Map();
const VISION_CACHE_SIZE = 8;

// Set-of-Marks outline colours, cycled so neighbouring refs stay distinguishable
const MARK_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

// 3. Forward model loading progress to the extension runtime (sidepanel)
worker.addEventListener('message', (e) => {
    if (e.data.type === 'STATUS') {
        console.log('[Florence Offscreen]', e.data.message);
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'PROGRESS') {
        console.log('[Florence Download]', e.data.progress);
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'MODEL_READY') {
        console.log(`[Florence] Model is ready on ${e.data.device}!`);
        modelState = e.data;
        chrome.runtime.sendMessage(e.data).catch(() => {});
    } else if (e.data.type === 'ERROR' && e.data.requestId === undefined) {
        // Model loading failed (detection errors carry a requestId and are answered by detect())
        console.error('[Florence] Model failed to load:', e.data.error);
        modelState = e.data;
        chrome.runtime.sendMessage(e.data).catch(() => {});
    }
});

// One Florence detection on the worker. Replies are matched by requestId, otherwise overlapping calls
// could paint one screenshot's regions onto another and leave its own PII unredacted
function detect(imageDataUrl) {
    return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        const onReply = (e) => {
            if (e.data.requestId !== requestId) return;
            worker.removeEventListener('message', onReply);
            if (e.data.type === 'RESULTS') resolve(e.data);
            else reject(new Error(e.data.error));
        };
        worker.addEventListener('message', onReply);
        worker.postMessage({ type: 'DETECT', requestId, imageDataUrl });
    });
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Pass 2, only where DOM scanning cannot read: the media regions, cut out of the screenshot onto a white
// canvas. No media on screen means nothing is left for vision to find. Without a DOM scan
// (mediaRegions undefined, e.g. the page blocks content scripts) the whole screenshot is analysed.
async function runVision(img, mediaRegions) {
    if (Array.isArray(mediaRegions) && mediaRegions.length === 0) {
        return { regions: [], latencyMs: 0, mode: 'skipped' };
    }
    const areas = mediaRegions || [{ x: 0, y: 0, w: img.width, h: img.height }];

    // Crop to the media's bounding box: Florence shrinks every input to 768x768, so a tighter crop
    // leaves more detail on the images themselves
    const x1 = Math.max(0, Math.floor(Math.min(...areas.map((r) => r.x))));
    const y1 = Math.max(0, Math.floor(Math.min(...areas.map((r) => r.y))));
    const x2 = Math.min(img.width, Math.ceil(Math.max(...areas.map((r) => r.x + r.w))));
    const y2 = Math.min(img.height, Math.ceil(Math.max(...areas.map((r) => r.y + r.h))));
    if (x2 - x1 < 1 || y2 - y1 < 1) {
        return { regions: [], latencyMs: 0, mode: 'skipped' };
    }
    const crop = document.createElement('canvas');
    crop.width = x2 - x1;
    crop.height = y2 - y1;
    const c = crop.getContext('2d');
    c.fillStyle = '#FFFFFF';
    c.fillRect(0, 0, crop.width, crop.height);
    for (const r of areas) c.drawImage(img, r.x, r.y, r.w, r.h, r.x - x1, r.y - y1, r.w, r.h);

    const key = `${x1},${y1}:${await sha256Hex(c.getImageData(0, 0, crop.width, crop.height).data)}`;
    if (visionCache.has(key)) {
        return { regions: visionCache.get(key), latencyMs: 0, mode: 'cached' };
    }

    const result = await detect(crop.toDataURL('image/png'));
    const regions = (result.regions || []).map((r) => ({ ...r, bbox: { ...r.bbox, x: r.bbox.x + x1, y: r.bbox.y + y1 } }));
    visionCache.set(key, regions);
    if (visionCache.size > VISION_CACHE_SIZE) visionCache.delete(visionCache.keys().next().value);
    return { regions, latencyMs: result.latencyMs, mode: 'ran' };
}

// Pass 3: blur faces, black out text PII, draw consistent fake values over emails (semantic_mock)
function redact(ctx, img, boxes) {
    const mockedMappings = [];
    const manifest = { redacted_regions: [] };

    boxes.forEach((box) => {
        const b = box.bbox || box;
        let x, y, w, h;

        // Regions arrive as pre-normalized {x, y, w, h} objects in screenshot pixels
        x = b.x ?? 0;
        y = b.y ?? 0;
        w = b.w ?? b.width ?? 0;
        h = b.h ?? b.height ?? 0;

        if (w <= 0 || h <= 0) return;

        const label = (box.type || box.label || box.category || '').toLowerCase();
        const realText = box.text_snippet || box.text || 'Sensitive Data';

        // Check categories
        const isImage = label.includes('image') || label.includes('face') || label.includes('photo') || label.includes('picture') || box.method === 'gaussian_blur';
        const isBlackBox = label.includes('password') || label.includes('secret') || label.includes('card') || label.includes('cvv') || label.includes('aadhaar') || label.includes('pan') || box.method === 'black_box';

        let methodUsed = 'semantic_mock';

        if (isImage) {
            methodUsed = 'gaussian_blur';
            // --- 1. GAUSSIAN BLUR FOR IMAGES & FACES ---
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.filter = 'blur(14px)';
            ctx.drawImage(img, 0, 0);
            ctx.restore();

        } else if (isBlackBox) {
            methodUsed = 'black_box';
            // --- 2. SOLID BLACKOUT FOR PASSWORDS, AADHAAR, PAN & CARDS ---
            // 4px padding to prevent anti-aliasing text bleed
            ctx.fillStyle = '#000000';
            ctx.fillRect(Math.max(0, x - 4), Math.max(0, y - 3), w + 8, h + 6);

        } else {
            methodUsed = 'semantic_mock';
            // --- 3. MOCK SENSITIVE PII (Email) with a fake value that stays the same all run ---
            // Same padding as the black box, so no anti-aliased edge of the real text survives
            const px = Math.max(0, x - 4);
            const py = Math.max(0, y - 3);
            const pw = w + 8;
            const ph = h + 6;
            ctx.fillStyle = '#FFFFFF';
            ctx.fillRect(px, py, pw, ph);

            const fakeText = masker.getFakeValue(realText, label);

            ctx.save();
            ctx.beginPath();
            ctx.rect(px, py, pw, ph);
            ctx.clip();
            ctx.fillStyle = '#000000';
            let fontSize = Math.max(10, Math.round(h * 0.7));
            ctx.font = `${fontSize}px sans-serif`;
            // Shrink to the original width so the fake value does not spill over neighbouring content
            const textWidth = ctx.measureText(fakeText).width;
            if (textWidth > pw - 4) {
                fontSize = Math.max(8, Math.floor(fontSize * (pw - 4) / textWidth));
                ctx.font = `${fontSize}px sans-serif`;
            }
            ctx.textBaseline = 'middle';
            ctx.fillText(fakeText, x + 2, y + h / 2);
            ctx.restore();

            mockedMappings.push({ real: realText, fake: fakeText });
        }

        manifest.redacted_regions.push({
            type: label || 'pii',
            method: methodUsed,
            source: box.source || 'unknown',
            bbox: {
                x: Math.round(x),
                y: Math.round(y),
                w: Math.round(w),
                h: Math.round(h)
            }
        });
    });

    return { manifest, mockedMappings };
}

// Set-of-Marks: outline every interactive element and tag it with its ref, so the model can answer
// "click e7" instead of guessing pixel coordinates. Drawn after redaction; marks reveal nothing.
function drawMarks(ctx, elements, imageWidth) {
    const fontSize = Math.max(11, Math.round(imageWidth / 110));
    ctx.font = `bold ${fontSize}px sans-serif`;
    ctx.textBaseline = 'top';
    elements.forEach((el, i) => {
        const { x, y, w, h } = el.bbox;
        const color = MARK_COLORS[i % MARK_COLORS.length];
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, w, h);
        // Tag just above the top-left corner, or inside it when the element touches the top edge
        const tagW = ctx.measureText(el.ref).width + 6;
        const tagH = fontSize + 4;
        const tagY = y >= tagH ? y - tagH : y;
        ctx.fillStyle = color;
        ctx.fillRect(x, tagY, tagW, tagH);
        ctx.fillStyle = '#FFFFFF';
        ctx.fillText(el.ref, x + 3, tagY + 2);
    });
}

// 4. Listen for detection requests from sidepanel.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'GET_MODEL_STATUS') {
        sendResponse(modelState);
        return;
    }

    if (message.action === 'RESET_MASKER') {
        // New agent run: start numbering fake values again
        masker = new PIIMasker();
        sendResponse(true);
        return;
    }

    if (message.action === 'RUN_FLORENCE') {
        const img = new Image();
        img.onload = async () => {
            try {
                const vision = await runVision(img, message.mediaRegions);

                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                // DOM-scan regions (Pass 1, already in screenshot pixels) + vision regions (Pass 2)
                const { manifest, mockedMappings } = redact(ctx, img, [...(message.domRegions || []), ...vision.regions]);
                drawMarks(ctx, message.elements || [], img.width);

                sendResponse({
                    success: true,
                    redactedUrl: canvas.toDataURL('image/jpeg', 0.95),
                    manifest,
                    mockedMappings,
                    latencyMs: vision.latencyMs,
                    visionMode: vision.mode
                });
            } catch (err) {
                sendResponse({ success: false, error: err.message });
            }
        };
        img.onerror = () => sendResponse({ success: false, error: 'Could not decode the screenshot' });
        img.src = message.image;

        // Keep the channel open for the async response
        return true;
    }
});
