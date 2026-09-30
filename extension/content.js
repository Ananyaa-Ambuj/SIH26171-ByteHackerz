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

        // The VLM answers in screenshot pixels, and captureVisibleTab captures at devicePixelRatio
        // (OS scaling x zoom), while elementFromPoint and marker placement use CSS pixels
        const dpr = window.devicePixelRatio || 1;
        const coordinates = Array.isArray(data.coordinates) && data.coordinates.length >= 2
            ? [Number(data.coordinates[0]) / dpr, Number(data.coordinates[1]) / dpr]
            : null;

        console.log('[Privag Content] Executing action:', data);

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

        try {
            if (action === 'click') {
                if (coordinates) {
                    const [x, y] = coordinates;
                    showVisualMarker(x, y, `Click: ${target || ''}`);

                    const el = document.elementFromPoint(x, y);
                    if (el) {
                        el.focus?.();
                        el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                        el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, clientX: x, clientY: y }));
                        el.click?.();
                        sendResponse({ success: true, message: `Clicked element at (${x}, ${y})` });
                        return true;
                    }
                }
                sendResponse({ success: false, message: 'Could not find element at coordinates' });
                return true;

            } else if (action === 'type') {
                let targetEl = null;
                if (coordinates) {
                    targetEl = document.elementFromPoint(coordinates[0], coordinates[1]);
                    showVisualMarker(coordinates[0], coordinates[1], `Type: ${value || ''}`);
                }

                if (!targetEl) {
                    targetEl = document.activeElement;
                }

                if (targetEl && ('value' in targetEl)) {
                    targetEl.focus();
                    // Assign through the prototype's native setter: React tracks the value on the element
                    // itself and would otherwise ignore the input event and drop the typed text
                    const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(targetEl), 'value')?.set;
                    if (nativeSetter) nativeSetter.call(targetEl, value || '');
                    else targetEl.value = value || '';
                    targetEl.dispatchEvent(new Event('input', { bubbles: true }));
                    targetEl.dispatchEvent(new Event('change', { bubbles: true }));
                    sendResponse({ success: true, message: `Typed into target` });
                    return true;
                }

                sendResponse({ success: false, message: 'No editable input found' });
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

// Pass 1: deterministic DOM scan. Runs the PII patterns on the exact DOM text and form values, so PII
// is found even where Florence's OCR misreads it. Boxes are returned in screenshot pixels
// (CSS px x devicePixelRatio, the scale captureVisibleTab captures at).
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

    // Records the on-screen part of a viewport rect, in screenshot pixels
    const addRegion = (rect, type, source) => {
        const x1 = Math.max(0, rect.left);
        const y1 = Math.max(0, rect.top);
        const x2 = Math.min(window.innerWidth, rect.right);
        const y2 = Math.min(window.innerHeight, rect.bottom);
        if (x2 - x1 < 1 || y2 - y1 < 1) return false;
        regions.push({ type, method: 'black_box', source, bbox: { x: x1 * dpr, y: y1 * dpr, w: (x2 - x1) * dpr, h: (y2 - y1) * dpr } });
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

    // 1. Visible text: box each match exactly via a Range (a match wrapping across lines gives several rects)
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE|TEXTAREA)$/.test(node.parentNode?.nodeName || '')
            ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.nodeValue;
        if (text.length < 6) continue;
        for (const [type, regex] of Object.entries(patterns)) {
            regex.lastIndex = 0;
            for (let m = regex.exec(text); m; m = regex.exec(text)) {
                const range = document.createRange();
                range.setStart(node, m.index);
                range.setEnd(node, m.index + m[0].length);
                for (const rect of range.getClientRects()) addRegion(rect, type, 'dom_text');
            }
        }
    }

    // 2. Form fields: values are not DOM text, so box the whole field
    const formFields = [];
    for (const el of document.querySelectorAll('input, textarea')) {
        if (/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test(el.type)) continue;
        const rect = el.getBoundingClientRect();
        if (!inViewport(rect)) continue;
        const byPurpose = sensitiveFieldType(el);
        const types = byPurpose ? [byPurpose] : matchTypes(el.value);
        const redacted = Boolean(el.value) && types.length > 0 && addRegion(rect, types.join(', '), 'dom_field');
        if (formFields.length < 50) {
            formFields.push({ name: scrub(el.name || el.id || ''), type: el.type || el.tagName.toLowerCase(), redacted });
        }
    }

    // 3. Visible button labels give the VLM context; scrubbed because account menus often show an email
    const visibleButtons = [];
    for (const el of document.querySelectorAll('button, input[type="submit"], input[type="button"], [role="button"]')) {
        if (!inViewport(el.getBoundingClientRect())) continue;
        const label = scrub((el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()).slice(0, 60);
        if (label) visibleButtons.push(label);
        if (visibleButtons.length >= 50) break;
    }

    return {
        regions,
        dom_structure: { visible_buttons: visibleButtons, form_fields: formFields },
        scanMs: Math.round(performance.now() - start),
    };
}