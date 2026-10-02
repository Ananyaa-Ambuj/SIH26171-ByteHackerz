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

// A detection that takes longer than this is treated as failed, so a stuck worker withholds the frame
// instead of hanging the agent
const DETECT_TIMEOUT_MS = 180000;

// Set-of-Marks outline colours, cycled so neighbouring refs stay distinguishable
const MARK_COLORS = ['#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2'];

// Solid mask colour for faces and profile photos (distinct from the black boxes over text)
const SOLID_MASK_COLOR = '#7f7f7f';

// Requests waiting for the worker, so a crashed worker can fail them all at once
const pending = new Map();

// Set when this page runs inside a Firefox panel (offscreen.html?host=<id>; Firefox has no offscreen API): it
// then answers only that panel and tags what it broadcasts, so other windows' panels and hosts ignore it.
// Chrome's offscreen document has no host id and serves every panel.
const host = new URLSearchParams(location.search).get('host');
const broadcast = (data) => chrome.runtime.sendMessage(host ? { ...data, host } : data).catch(() => {});

// 3. Forward model loading progress to the extension runtime (sidepanel)
worker.addEventListener('message', (e) => {
    if (e.data.type === 'STATUS') {
        console.log('[Florence Offscreen]', e.data.message);
        broadcast(e.data);
    } else if (e.data.type === 'PROGRESS') {
        broadcast(e.data);
    } else if (e.data.type === 'MODEL_READY') {
        console.log(`[Florence] Model is ready on ${e.data.device}!`);
        modelState = e.data;
        broadcast(e.data);
    } else if (e.data.type === 'ERROR' && e.data.requestId === undefined) {
        // Model loading failed (detection errors carry a requestId and are answered by detect())
        console.error('[Florence] Model failed to load:', e.data.error);
        modelState = e.data;
        broadcast(e.data);
    }
});

// A worker that crashed outright answers nothing: fail every waiting detection and mark the model unusable
worker.addEventListener('error', (e) => {
    modelState = { type: 'ERROR', error: `Vision worker crashed: ${e.message || 'unknown error'}` };
    broadcast(modelState);
    for (const fail of pending.values()) fail(new Error(modelState.error));
    pending.clear();
});

// One Florence detection on the worker. Replies are matched by requestId, otherwise overlapping calls
// could paint one screenshot's regions onto another and leave its own PII unredacted
function detect(imageDataUrl) {
    return new Promise((resolve, reject) => {
        const requestId = nextRequestId++;
        const finish = () => {
            worker.removeEventListener('message', onReply);
            clearTimeout(timer);
            pending.delete(requestId);
        };
        const onReply = (e) => {
            if (e.data.requestId !== requestId) return;
            finish();
            if (e.data.type === 'RESULTS') resolve(e.data);
            else reject(new Error(e.data.error));
        };
        const timer = setTimeout(() => {
            finish();
            reject(new Error('Vision detection timed out'));
        }, DETECT_TIMEOUT_MS);
        pending.set(requestId, (err) => {
            finish();
            reject(err);
        });
        worker.addEventListener('message', onReply);
        worker.postMessage({ type: 'DETECT', requestId, imageDataUrl });
    });
}

async function sha256Hex(bytes) {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const contains = (area, x, y) => x >= area.x && x <= area.x + area.w && y >= area.y && y <= area.y + area.h;

// Pass 2, only where DOM scanning cannot read: the media regions, cut out of the screenshot onto a white
// canvas. No media on screen means nothing is left for vision to find. Faces are solid-masked and text PII
// black-boxed; inside frames and embedded documents (which the DOM pass cannot read at all) EVERY line of
// text OCR finds is black-boxed, not only the lines that validate as PII (fail closed).
async function runVision(img, mediaRegions, domRegions) {
    if (mediaRegions.length === 0) {
        return { regions: [], latencyMs: 0, mode: 'skipped' };
    }
    if (modelState?.type !== 'MODEL_READY') {
        // A failed load is retried on the next frame that needs vision; meanwhile the frame is withheld
        if (modelState?.type === 'ERROR') {
            modelState = null;
            worker.postMessage({ type: 'LOAD_MODEL' });
        }
        const error = new Error('Florence-2 model is not loaded yet');
        error.code = 'MODEL_NOT_READY';
        throw error;
    }

    // Crop to the media's bounding box: Florence shrinks every input to 768x768, so a tighter crop
    // leaves more detail on the images themselves
    const x1 = Math.max(0, Math.floor(Math.min(...mediaRegions.map((r) => r.x))));
    const y1 = Math.max(0, Math.floor(Math.min(...mediaRegions.map((r) => r.y))));
    const x2 = Math.min(img.width, Math.ceil(Math.max(...mediaRegions.map((r) => r.x + r.w))));
    const y2 = Math.min(img.height, Math.ceil(Math.max(...mediaRegions.map((r) => r.y + r.h))));
    if (x2 - x1 < 1 || y2 - y1 < 1) {
        return { regions: [], latencyMs: 0, mode: 'skipped' };
    }
    const crop = document.createElement('canvas');
    crop.width = x2 - x1;
    crop.height = y2 - y1;
    const c = crop.getContext('2d');
    c.fillStyle = '#FFFFFF';
    c.fillRect(0, 0, crop.width, crop.height);
    for (const r of mediaRegions) c.drawImage(img, r.x, r.y, r.w, r.h, r.x - x1, r.y - y1, r.w, r.h);
    // DOM PII shown over an image (text on a background image) is already masked by Pass 1; hide it from OCR
    // so no vision box is ever placed on top of a fake value
    for (const r of domRegions) c.fillRect(r.bbox.x - x1 - 4, r.bbox.y - y1 - 3, r.bbox.w + 8, r.bbox.h + 6);

    const key = `${x1},${y1}:${await sha256Hex(c.getImageData(0, 0, crop.width, crop.height).data)}`;
    let result = visionCache.get(key);
    const cached = Boolean(result);
    if (!result) {
        const detection = await detect(crop.toDataURL('image/png'));
        const shift = (b) => ({ ...b, x: b.x + x1, y: b.y + y1 });
        result = {
            regions: (detection.regions || []).map((r) => ({ ...r, bbox: shift(r.bbox) })),
            otherText: (detection.otherText || []).map((t) => shift(t.bbox)),
            latencyMs: detection.latencyMs,
            device: detection.device,
            ocrTruncated: Boolean(detection.ocrTruncated),
        };
        visionCache.set(key, result);
        if (visionCache.size > VISION_CACHE_SIZE) visionCache.delete(visionCache.keys().next().value);
    }

    const unscannable = mediaRegions.filter((r) => r.unscannable);
    // Florence can name a face or a text line without giving it a box: what has no position cannot be
    // masked, so the frame is withheld
    const noBox = (b) => !(b.w > 0 && b.h > 0);
    if (result.regions.some((r) => noBox(r.bbox)) || (unscannable.length && result.otherText.some(noBox))) {
        const error = new Error('the vision model reported a face or text without a usable position');
        error.code = 'VISION_INCOMPLETE';
        throw error;
    }
    const unverified = result.otherText
        .filter((b) => unscannable.some((area) => contains(area, b.x + b.w / 2, b.y + b.h / 2)))
        .map((bbox) => ({ type: 'unverified_text', source: 'florence_ocr', method: 'black_box', bbox }));
    // OCR stopped at its token limit: text after the cut was never read, so every area it ran on is blacked out
    const unread = result.ocrTruncated
        ? mediaRegions.map((r) => ({ type: 'unread_text', source: 'florence_ocr', method: 'black_box', bbox: { x: r.x, y: r.y, w: r.w, h: r.h } }))
        : [];
    return {
        regions: [...result.regions, ...unverified, ...unread],
        latencyMs: cached ? 0 : result.latencyMs,
        device: result.device,
        mode: cached ? 'cached' : 'ran',
    };
}

// A DOM detection's fake value, drawn where the real one was on the page's own background colour so the page
// keeps its structure. Fields keep their border; text gets the black box's padding so no anti-aliased edge
// of the real value survives.
function drawFake(ctx, box, x, y, w, h) {
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

    const shown = box.value || '';
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
}

// Pass 3. Every region carries its method (decided by the side panel for DOM detections, by the worker for
// vision ones): black_box = solid black with padding (passwords, OTPs, card and ID numbers, text in images),
// solid_mask = solid grey (faces, profile photos), semantic_mock = the vault's format-preserving fake.
// Masks are drawn first and fakes last, so no box can ever cover a fake value the model may need to read.
function redact(ctx, boxes) {
    const manifest = { redacted_regions: [] };
    const order = (box) => (box.method === 'semantic_mock' ? 1 : 0);

    [...boxes].sort((a, b) => order(a) - order(b)).forEach((box) => {
        const { x, y, w, h } = box.bbox;
        if (!(w > 0 && h > 0)) return;

        if (box.method === 'solid_mask') {
            ctx.fillStyle = SOLID_MASK_COLOR;
            ctx.fillRect(x, y, w, h);
        } else if (box.method === 'semantic_mock') {
            drawFake(ctx, box, x, y, w, h);
        } else {
            // black_box, and anything unexpected: 4/3 px padding so no anti-aliased glyph edge survives
            ctx.fillStyle = '#000000';
            ctx.fillRect(Math.max(0, x - 4), Math.max(0, y - 3), w + 8, h + 6);
        }

        manifest.redacted_regions.push({
            type: box.type || 'pii',
            method: box.method === 'solid_mask' || box.method === 'semantic_mock' ? box.method : 'black_box',
            source: box.source,
            // The placeholder shown in the image (fakes) or stood in for it (black-boxed IDs), so the model
            // can reuse it exactly; the vault restores the real value only where it belongs
            ...(box.method !== 'solid_mask' && typeof box.value === 'string' && { value: box.value }),
            bbox: { x: Math.max(0, Math.round(x)), y: Math.max(0, Math.round(y)), w: Math.round(w), h: Math.round(h) },
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
    if (host && message.host !== host) return;
    if (message.action === 'GET_MODEL_STATUS') {
        sendResponse(modelState);
        return;
    }

    if (message.action === 'RUN_FLORENCE') {
        const img = new Image();
        img.onload = async () => {
            try {
                const domRegions = message.domRegions || [];
                const vision = await runVision(img, message.mediaRegions || [], domRegions);

                const maskStart = performance.now();
                const canvas = document.createElement('canvas');
                canvas.width = img.width;
                canvas.height = img.height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0);

                const { manifest } = redact(ctx, [...vision.regions, ...domRegions]);
                drawMarks(ctx, message.elements || [], img.width);
                const redactedUrl = canvas.toDataURL('image/jpeg', 0.95);

                sendResponse({
                    success: true,
                    redactedUrl,
                    manifest,
                    latencyMs: vision.latencyMs,
                    visionMode: vision.mode,
                    device: vision.device || modelState?.device || null,
                    maskMs: Math.round(performance.now() - maskStart),
                });
            } catch (err) {
                sendResponse({ success: false, code: err.code || 'VISION_FAILED', error: err.message });
            }
        };
        img.onerror = () => sendResponse({ success: false, code: 'BAD_IMAGE', error: 'Could not decode the screenshot' });
        img.src = message.image;

        // Keep the channel open for the async response
        return true;
    }
});
