// 1. Start Florence-2 Web Worker
const worker = new Worker('florence-worker.bundle.js', { type: 'module' });

// 2. Start pre-loading the model onto WebGPU
worker.postMessage({ type: 'LOAD_MODEL' });

// Final MODEL_READY / load ERROR message, kept so a side panel opened later can ask for it
let modelState = null;
let nextRequestId = 1;

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
async function runVision(img, mediaRegions, domRegions) {
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
    // DOM PII shown over an image (text on a background image) already gets its fake from Pass 1; hide it
    // from OCR so no vision black box is ever placed on top of a fake value
    for (const r of domRegions || []) c.fillRect(r.bbox.x - x1 - 4, r.bbox.y - y1 - 3, r.bbox.w + 8, r.bbox.h + 6);

    const key =`${x1},${y1}:${await sha256Hex(c.getImageData(0, 0, crop.width, crop.height).data)}`;
    if (visionCache.has(key)) {
        return { regions: visionCache.get(key), latencyMs: 0, mode: 'cached' };
    }

    const result = await detect(crop.toDataURL('image/png'));
    const regions = (result.regions || []).map((r) => ({ ...r, bbox: { ...r.bbox, x: r.bbox.x + x1, y: r.bbox.y + y1 } }));
    visionCache.set(key, regions);
    if (visionCache.size > VISION_CACHE_SIZE) visionCache.delete(visionCache.keys().next().value);
    return { regions, latencyMs: result.latencyMs, mode: 'ran' };
}

// A DOM detection's fake value, drawn where the real one was on the page's own background colour so the page
// keeps its structure. Fields keep their border; text gets the black box's padding so no anti-aliased edge
// of the real value survives. Passwords show a fixed row of dots, which also hides the real length.
function drawFake(ctx, box, x, y, w, h, label) {
    const field = box.source === 'dom_field';
    const [px, py, pw, ph] = field ? [x + 2, y + 2, w - 4, h - 4] : [Math.max(0, x - 4), Math.max(0, y - 3), w + 8, h + 6];

    // Background: per-channel median of the value's own inner corners, which glyphs rarely touch. (The padded
    // box's corners can land on a surrounding border, e.g. the edge of a button.)
    const clampX = (v) => Math.min(ctx.canvas.width - 1, Math.max(0, Math.round(v)));
    const clampY = (v) => Math.min(ctx.canvas.height - 1, Math.max(0, Math.round(v)));
    const inset = field ? 3 : 1;
    const corners = [[x + inset, y + inset], [x + w - 1 - inset, y + inset], [x + inset, y + h - 1 - inset], [x + w - 1 - inset, y + h - 1 - inset]]
        .map(([cx, cy]) => ctx.getImageData(clampX(cx), clampY(cy), 1, 1).data);
    const [r, g, b] = [0, 1, 2].map((i) => {
        const v = corners.map((c) => c[i]).sort((m, n) => m - n);
        return Math.round((v[1] + v[2]) / 2);
    });
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(px, py, pw, ph);

    const shown = label === 'password' ? '••••••••' : (box.fake || '');
    ctx.save();
    ctx.beginPath();
    ctx.rect(px, py, pw, ph);
    ctx.clip();
    ctx.fillStyle = 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#000000' : '#FFFFFF';
    // A text line box is ~1.15x its font size; a field box also holds padding
    let fontSize = Math.max(10, Math.round(h * (field ? 0.5 : 0.85)));
    ctx.font = `${fontSize}px sans-serif`;
    // Shrink to the original width so the fake value does not spill over neighbouring content
    const maxWidth = pw - (field ? 12 : 4);
    const textWidth = ctx.measureText(shown).width;
    if (textWidth > maxWidth) {
        fontSize = Math.max(8, Math.floor(fontSize * maxWidth / textWidth));
        ctx.font = `${fontSize}px sans-serif`;
    }
    ctx.textBaseline = 'middle';
    ctx.fillText(shown, field ? x + 8 : x, y + h / 2);
    ctx.restore();
    return shown;
}

// Pass 3. Image-based (Florence) detections: faces blurred, text in images blacked out. DOM detections: the
// side panel's format-preserving fake drawn over the real value (semantic_mock). An explicit method always
// wins over the label heuristics, which only classify regions that arrive without one.
function redact(ctx, img, boxes) {
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

        // Check categories
        const isImage = label.includes('image') || label.includes('face') || label.includes('photo') || label.includes('picture');
        const isBlackBox = label.includes('password') || label.includes('secret') || label.includes('card') || label.includes('cvv') || label.includes('aadhaar') || label.includes('pan');
        const methodUsed = box.method || (isImage ? 'gaussian_blur' : isBlackBox ? 'black_box' : 'semantic_mock');
        let shown;

        if (methodUsed === 'gaussian_blur') {
            // --- 1. GAUSSIAN BLUR FOR IMAGES & FACES ---
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();
            ctx.filter = 'blur(14px)';
            ctx.drawImage(img, 0, 0);
            ctx.restore();

        } else if (methodUsed === 'black_box') {
            // --- 2. SOLID BLACKOUT FOR TEXT PII INSIDE IMAGES ---
            // 4px padding to prevent anti-aliasing text bleed
            ctx.fillStyle = '#000000';
            ctx.fillRect(Math.max(0, x - 4), Math.max(0, y - 3), w + 8, h + 6);

        } else {
            // --- 3. FORMAT-PRESERVING FAKE FOR PII FOUND IN THE DOM ---
            shown = drawFake(ctx, box, x, y, w, h, label);
        }

        manifest.redacted_regions.push({
            type: label || 'pii',
            method: methodUsed,
            source: box.source || 'unknown',
            // The fake shown in the image, so the model can reuse it exactly (the vault restores the real value)
            ...(shown !== undefined && { value: shown }),
            bbox: {
                x: Math.round(x),
                y: Math.round(y),
                w: Math.round(w),
                h: Math.round(h)
            }
        });
    });

    return { manifest };
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

    if (message.action === 'RUN_FLORENCE') {
        const img = new Image();
        img.onload = async () => {
            try {
                const vision = await runVision(img, message.mediaRegions, message.domRegions);

                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                // Vision regions (Pass 2) first, DOM-scan fakes (Pass 1, already in screenshot pixels) last, so
                // no black box or blur can ever cover a fake value
                const { manifest } = redact(ctx, img, [...vision.regions, ...(message.domRegions || [])]);
                drawMarks(ctx, message.elements || [], img.width);

                sendResponse({
                    success: true,
                    redactedUrl: canvas.toDataURL('image/jpeg', 0.95),
                    manifest,
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
