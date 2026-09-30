// sidepanel.js re-injects this file before every capture. Replace the previous listener instead of
// stacking another one, which made every click/type/scroll run once per injection.
if (window.__privagMessageListener) {
    chrome.runtime.onMessage.removeListener(window.__privagMessageListener);
}
window.__privagMessageListener = handlePrivagMessage;
chrome.runtime.onMessage.addListener(handlePrivagMessage);

function handlePrivagMessage(message, sender, sendResponse) {

    if (message.action === "SCAN_PII") {
        sendResponse(scanPagePII());
        return true;
    }

    else if (message.action === "EXECUTE_ACTION") {
        const data = message.data || {};
        const { action, target, value } = data;

        // Preferred target: the element behind a ref from the last scan -- exact, no coordinate guessing.
        // A stale ref (element gone since the scan) falls back to the coordinates, if any.
        const ref = data.ref ? String(data.ref).replace(/^@/, '') : null;
        const refElement = ref && window.__privagRefs?.get(ref)?.isConnected ? window.__privagRefs.get(ref) : null;

        // The VLM answers in screenshot pixels, and captureVisibleTab captures at devicePixelRatio
        // (OS scaling x zoom), while elementFromPoint and marker placement use CSS pixels
        const dpr = window.devicePixelRatio || 1;
        let coordinates = Array.isArray(data.coordinates) && data.coordinates.length >= 2
            ? [Number(data.coordinates[0]) / dpr, Number(data.coordinates[1]) / dpr]
            : null;
        if (refElement) {
            refElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            const r = refElement.getBoundingClientRect();
            coordinates = [r.left + r.width / 2, r.top + r.height / 2];
        }
        const elementAt = (point) => refElement || (point ? document.elementFromPoint(point[0], point[1]) : null);
        const missing = ref && !refElement ? `Element ${ref} is no longer on the page` : null;

        console.log('[Privag Content] Executing action:', data.action, ref || data.coordinates);

        // Visual pointer ripple for live demonstrations
        function showVisualMarker(x, y, label) {
            const marker = document.createElement('div');
            marker.style.position = 'fixed';
            marker.style.left = `${x - 15}px`;
            marker.style.top = `${y - 15}px`;
            marker.style.width = '30px';
            marker.style.height = '30px';
            marker.style.borderRadius = '50%';
            marker.style.border = '3px solid #EF4444';
            marker.style.backgroundColor = 'rgba(239, 68, 68, 0.3)';
            marker.style.zIndex = '9999999';
            marker.style.pointerEvents = 'none';
            marker.style.transition = 'all 0.5s ease-out';
            marker.style.boxShadow = '0 0 15px rgba(239, 68, 68, 0.8)';

            if (label) {
                const tag = document.createElement('span');
                tag.textContent = label;
                tag.style.position = 'absolute';
                tag.style.bottom = '-20px';
                tag.style.left = '50%';
                tag.style.transform = 'translateX(-50%)';
                tag.style.background = '#1E293B';
                tag.style.color = '#FFFFFF';
                tag.style.padding = '2px 6px';
                tag.style.borderRadius = '4px';
                tag.style.fontSize = '11px';
                tag.style.fontWeight = 'bold';
                tag.style.whiteSpace = 'nowrap';
                marker.appendChild(tag);
            }

            document.body.appendChild(marker);

            setTimeout(() => {
                marker.style.transform = 'scale(1.8)';
                marker.style.opacity = '0';
            }, 300);

            setTimeout(() => {
                marker.remove();
            }, 800);
        }

        // Assign through the prototype's native setter: React tracks the value on the element
        // itself and would otherwise ignore the input event and drop the typed text
        function setNativeValue(el, newValue) {
            const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value')?.set;
            if (nativeSetter) nativeSetter.call(el, newValue);
            else el.value = newValue;
            el.dispatchEvent(new Event('input', { bubbles: true }));
            el.dispatchEvent(new Event('change', { bubbles: true }));
        }

        // Result messages go back to the server as the model's observation, so they never echo the
        // typed value (after local unmasking it can be a real email)
        try {
            if (action === 'click') {
                const el = elementAt(coordinates);
                if (el && coordinates) {
                    const [x, y] = coordinates;
                    showVisualMarker(x, y, `Click: ${ref || target || ''}`);
                    el.focus?.();
                    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                    el.click?.();
                    sendResponse({ success: true, message: refElement ? `Clicked ${ref}` : `Clicked element at (${Math.round(x)}, ${Math.round(y)})` });
                    return true;
                }
                sendResponse({ success: false, message: missing || 'Could not find element at coordinates' });
                return true;

            } else if (action === 'type') {
                let targetEl = elementAt(coordinates);
                if (coordinates) {
                    showVisualMarker(coordinates[0], coordinates[1], `Type: ${ref || target || ''}`);
                }

                if (!targetEl && !missing) {
                    targetEl = document.activeElement;
                }

                if (targetEl?.localName === 'select') {
                    // Pick the option whose visible text or value matches, as a person would
                    const wanted = String(value ?? '').trim().toLowerCase();
                    const option = [...targetEl.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted);
                    if (!option) {
                        sendResponse({ success: false, message: 'No matching option in the dropdown' });
                        return true;
                    }
                    setNativeValue(targetEl, option.value);
                    sendResponse({ success: true, message: `Selected "${option.text.trim()}"` });
                    return true;
                }

                if (targetEl?.isContentEditable) {
                    // Rich-text editors (chat boxes, compose windows) only react to real text insertion;
                    // execCommand is deprecated but still the one API that inserts text like typing does
                    targetEl.focus();
                    document.execCommand('selectAll', false);
                    document.execCommand('insertText', false, value || '');
                    sendResponse({ success: true, message: 'Typed into target' });
                    return true;
                }

                if (targetEl && ('value' in targetEl)) {
                    targetEl.focus();
                    setNativeValue(targetEl, value || '');
                    sendResponse({ success: true, message: `Typed into target` });
                    return true;
                }

                sendResponse({ success: false, message: missing || 'No editable input found' });
                return true;

            } else if (action === 'scroll') {
                const scrollAmount = value === 'up' ? -400 : 400;
                window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
                sendResponse({ success: true, message: `Scrolled ${value || 'down'}` });
                return true;

            } else if (action === 'wait' || action === 'done') {
                sendResponse({ success: true, message: `Action ${action} acknowledged` });
                return true;
            }

            sendResponse({ success: false, message: `Unrecognized action: ${action}` });
        } catch (err) {
            console.error('[Privag Content] Execution error:', err);
            sendResponse({ success: false, error: err.message });
        }
    }
}

// Pass 1: deterministic DOM scan. Returns, in screenshot pixels (CSS px x devicePixelRatio, the scale
// captureVisibleTab captures at):
//  - regions: PII found in the exact DOM text and form values, so OCR misreads don't matter
//  - elements: interactive elements with refs the model can target (Set-of-Marks)
//  - mediaRegions: images, video, canvas, frames and CSS background images -- the only places left
//    where PII can appear outside DOM text, so the only places the vision model still has to look
// Everything lives inside this function: the file is re-injected, and top-level const/let would throw.
function scanPagePII() {
    const start = performance.now();
    // Exact-text patterns; the vision worker's OCR patterns are looser to tolerate misreads
    const patterns = {
        aadhaar: /\d{4}[\s-]?\d{4}[\s-]?\d{4}/g,
        pan: /[A-Z]{5}\d{4}[A-Z]/g,
        phone: /[6-9]\d{4}[\s-]?\d{5}/g,
        email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    };
    const dpr = window.devicePixelRatio || 1;
    const regions = [];

    const inViewport = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth;
    const matchTypes = (text) => Object.keys(patterns).filter((type) => {
        patterns[type].lastIndex = 0;
        return patterns[type].test(text);
    });
    const scrub = (text) => Object.values(patterns).reduce((t, re) => t.replace(re, '[REDACTED]'), text);

    // The on-screen part of a viewport rect, in screenshot pixels (null when off-screen)
    const toShot = (rect) => {
        const x1 = Math.max(0, rect.left);
        const y1 = Math.max(0, rect.top);
        const x2 = Math.min(window.innerWidth, rect.right);
        const y2 = Math.min(window.innerHeight, rect.bottom);
        if (x2 - x1 < 1 || y2 - y1 < 1) return null;
        return { x: x1 * dpr, y: y1 * dpr, w: (x2 - x1) * dpr, h: (y2 - y1) * dpr };
    };

    // Emails get a consistent fake value drawn over them (semantic_mock, see pii-masker.js); their real
    // text travels no further than the offscreen document. Everything else is blacked out.
    const addRegion = (rect, type, source, text) => {
        const bbox = toShot(rect);
        if (!bbox) return false;
        regions.push(type === 'email'
            ? { type, method: 'semantic_mock', source, bbox, text }
            : { type, method: 'black_box', source, bbox });
        return true;
    };

    // Fields that hold PII by purpose (the documented Pass 1 selectors), whatever their value looks like.
    // PAN needs a word match: a plain substring would flag fields like "company".
    const sensitiveFieldType = (el) => {
        const hint = `${el.name} ${el.id} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (el.type === 'password') return 'password';
        if (autocomplete.startsWith('cc-')) return 'card';
        if (/aadha?ar|adhaa?r/.test(hint)) return 'aadhaar';
        if (/\bpan\b|pan[\s_-]?(no|num|card)/.test(hint)) return 'pan';
        if (el.type === 'email' || autocomplete === 'email' || /e-?mail/.test(hint)) return 'email';
        if (el.type === 'tel' || autocomplete.startsWith('tel') || /phone|mobile/.test(hint)) return 'phone';
        return null;
    };

    // 0. One pass over every element: find shadow roots (web components hide text and fields from plain
    //    queries; content scripts may open closed roots too) and on-screen visual media
    const roots = [document];
    const mediaRegions = [];
    for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll('*')) {
            const shadow = chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot;
            if (shadow) roots.push(shadow);
            const rect = el.getBoundingClientRect();
            if (rect.width < 24 || rect.height < 24 || !inViewport(rect)) continue;
            if (/^(img|video|canvas|iframe|embed|object|image)$/.test(el.localName) ||
                getComputedStyle(el).backgroundImage.includes('url(')) {
                const bbox = toShot(rect);
                if (bbox) mediaRegions.push(bbox);
            }
        }
    }

    // 1. Visible text: box each match exactly via a Range (a match wrapping across lines gives several rects)
    const textFilter = {
        acceptNode: (node) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/.test(node.parentNode?.nodeName || '')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    };
    for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, textFilter);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const text = node.nodeValue;
            if (text.length < 6) continue;
            for (const [type, regex] of Object.entries(patterns)) {
                regex.lastIndex = 0;
                for (let m = regex.exec(text); m; m = regex.exec(text)) {
                    const range = document.createRange();
                    range.setStart(node, m.index);
                    range.setEnd(node, m.index + m[0].length);
                    for (const rect of range.getClientRects()) addRegion(rect, type, 'dom_text', m[0]);
                }
            }
        }
    }

    // 2. Form fields: values are not DOM text, so box the whole field
    const redactedFields = new Set();
    for (const root of roots) {
        for (const el of root.querySelectorAll('input, textarea')) {
            if (/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test(el.type)) continue;
            const rect = el.getBoundingClientRect();
            if (!el.value || !inViewport(rect)) continue;
            const byPurpose = sensitiveFieldType(el);
            const types = byPurpose ? [byPurpose] : matchTypes(el.value);
            if (types.length > 0 && addRegion(rect, types.join(', '), 'dom_field', el.value)) redactedFields.add(el);
        }
    }

    // 3. Interactive elements get refs (e1, e2, ...) that the model targets instead of guessing pixel
    //    coordinates (chrome-use / Set-of-Marks style). The ref -> element map stays in this isolated world
    //    for EXECUTE_ACTION. Names are scrubbed of PII and field values are never included.
    const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], ' +
        '[contenteditable="true"], [onclick], [role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
        '[role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"]';
    const roleOf = (el) => {
        if (el.getAttribute('role')) return el.getAttribute('role');
        if (el.localName === 'a') return 'link';
        if (el.localName === 'select') return 'combobox';
        if (el.localName === 'textarea' || el.isContentEditable) return 'textbox';
        if (el.localName === 'input') {
            if (/^(submit|button|reset|image)$/.test(el.type)) return 'button';
            return el.type === 'checkbox' || el.type === 'radio' ? el.type : 'textbox';
        }
        return 'button';
    };
    const nameOf = (el) => (el.getAttribute('aria-label')
        || el.labels?.[0]?.innerText
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || el.getAttribute('alt')
        || (/^(input|textarea|select)$/.test(el.localName) ? '' : el.innerText)
        || el.querySelector?.('img[alt]')?.getAttribute('alt')
        || (/^(submit|button|reset)$/.test(el.type) ? el.value : '')
        || el.getAttribute('name')
        || el.id
        || '').replace(/\s+/g, ' ').trim();

    const refs = new Map();
    const elements = [];
    for (const root of roots) {
        for (const el of root.querySelectorAll(INTERACTIVE)) {
            if (elements.length >= 150) break;
            const rect = el.getBoundingClientRect();
            const bbox = inViewport(rect) ? toShot(rect) : null;
            if (!bbox) continue;
            // Skip elements hidden behind overlays: what is on top at their visible center must be them
            const topEl = root.elementFromPoint(bbox.x / dpr + bbox.w / dpr / 2, bbox.y / dpr + bbox.h / dpr / 2);
            if (topEl && topEl !== el && !el.contains(topEl)) continue;

            const ref = `e${elements.length + 1}`;
            refs.set(ref, el);
            const entry = {
                ref,
                role: roleOf(el),
                name: scrub(nameOf(el)).slice(0, 80),
                bbox: { x: Math.round(bbox.x), y: Math.round(bbox.y), w: Math.round(bbox.w), h: Math.round(bbox.h) },
            };
            if (entry.role === 'textbox' && 'value' in el) entry.filled = Boolean(el.value);
            if (redactedFields.has(el)) entry.redacted = true;
            if (el.disabled) entry.disabled = true;
            elements.push(entry);
        }
    }
    window.__privagRefs = refs;

    return {
        regions,
        elements,
        mediaRegions,
        scanMs: Math.round(performance.now() - start),
    };
}
