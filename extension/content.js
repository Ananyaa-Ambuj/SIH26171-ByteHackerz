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
        // Small models write refs loosely ("e7", "[e7]", "E7", a bare 7, or only in "target"): take the number.
        // A ref that cannot be resolved falls back to the coordinates, if any.
        const refText = data.ref ?? (/^\W*e\d+\W*$/i.test(String(target ?? '')) ? target : null);
        const refNumber = refText == null ? null : String(refText).match(/\d+/)?.[0];
        const ref = refNumber ? `e${Number(refNumber)}` : null;
        const refElement = ref ? privagResolveRef(ref) : null;

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
        const missing = !ref || refElement ? null
            : !window.__privagRefs?.has(ref) ? `No element ${ref} in the last page scan`
            : `Element ${ref} is no longer on the page`;

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
                    // The full sequence a real click produces: many menu/dropdown libraries react to pointerdown
                    // and never see a bare click()
                    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse', isPrimary: true };
                    el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
                    el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
                    el.dispatchEvent(new PointerEvent('pointerup', init));
                    el.dispatchEvent(new MouseEvent('mouseup', init));
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

                // A ref can point at a wrapper (e.g. a combobox div around its input): type into the field inside
                if (targetEl && !('value' in targetEl) && !targetEl.isContentEditable) {
                    targetEl = targetEl.querySelector('input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]') || targetEl;
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
    // Exact-text patterns shared with the side panel's vault (pii-masker.js, injected before this file), in
    // priority order; the vision worker's OCR patterns are looser to tolerate misreads
    const patterns = PIIMasker.PATTERNS;
    const dpr = window.devicePixelRatio || 1;
    const regions = [];

    const inViewport = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth;
    // The highest-priority PII type a value matches, e.g. "aadhaar" rather than "aadhaar, phone"
    const primaryType = (text) => Object.keys(patterns).find((type) => text.search(patterns[type]) >= 0);

    // The on-screen part of a viewport rect, in screenshot pixels (null when off-screen)
    const toShot = (rect) => {
        const x1 = Math.max(0, rect.left);
        const y1 = Math.max(0, rect.top);
        const x2 = Math.min(window.innerWidth, rect.right);
        const y2 = Math.min(window.innerHeight, rect.bottom);
        if (x2 - x1 < 1 || y2 - y1 < 1) return null;
        return { x: x1 * dpr, y: y1 * dpr, w: (x2 - x1) * dpr, h: (y2 - y1) * dpr };
    };

    // Everything found in the DOM is replaced by a format-preserving fake (semantic_mock). The real text goes
    // only as far as the side panel, which swaps it for the vault's fake before anything leaves it.
    const addRegion = (rect, type, source, text) => {
        const bbox = toShot(rect);
        if (!bbox) return false;
        regions.push({ type, method: 'semantic_mock', source, bbox, text });
        return true;
    };

    // Fields that hold PII by purpose (the documented Pass 1 selectors), whatever their value looks like.
    // PAN needs a word match: a plain substring would flag fields like "company".
    const sensitiveFieldType = (el) => {
        const hint = `${el.name} ${el.id} ${el.placeholder || ''} ${el.getAttribute('aria-label') || ''}`.toLowerCase();
        const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase();
        if (el.type === 'password') return 'password';
        if (autocomplete === 'cc-number') return 'card';
        // Other card fields (security code, expiry, holder) have no card-number shape: hide them like a password
        if (autocomplete.startsWith('cc-')) return 'password';
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
            // openOrClosedShadowRoot only accepts HTML elements and throws for SVG/MathML ones (which can't host
            // shadow roots anyway); one inline SVG icon used to abort the whole scan
            const shadow = el instanceof HTMLElement ? (chrome.dom?.openOrClosedShadowRoot?.(el) ?? el.shadowRoot) : null;
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
            // Types in priority order; a span already claimed (a card number) is not matched again (as an Aadhaar)
            const taken = [];
            for (const [type, regex] of Object.entries(patterns)) {
                for (const m of text.matchAll(regex)) {
                    const from = m.index;
                    const to = m.index + m[0].length;
                    if (taken.some(([s, e]) => from < e && s < to)) continue;
                    taken.push([from, to]);
                    const range = document.createRange();
                    range.setStart(node, from);
                    range.setEnd(node, to);
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
            // The value's own format decides (so the same value gets the same fake in any field); the field's
            // purpose covers values without one. Passwords always stay passwords, whatever they look like.
            const type = el.type === 'password' ? 'password' : (primaryType(el.value) || sensitiveFieldType(el));
            if (type && addRegion(rect, type, 'dom_field', el.value)) redactedFields.add(el);
        }
    }

    // 3. Interactive elements get refs (e1, e2, ...) that the model targets instead of guessing pixel
    //    coordinates (chrome-use / Set-of-Marks style). The ref -> element map stays in this isolated world
    //    for EXECUTE_ACTION. Names are returned as shown: the side panel replaces any PII in them with the
    //    vault's fakes (uncut, so no half-value escapes masking). Field values are never included.
    const refs = new Map();
    const elements = [];
    for (const root of roots) {
        for (const el of root.querySelectorAll(privagInteractiveSelector())) {
            if (elements.length >= 150) break;
            const rect = el.getBoundingClientRect();
            const bbox = inViewport(rect) ? toShot(rect) : null;
            if (!bbox) continue;
            // Skip elements hidden behind overlays: what is on top at their visible center must be them
            const topEl = root.elementFromPoint(bbox.x / dpr + bbox.w / dpr / 2, bbox.y / dpr + bbox.h / dpr / 2);
            if (topEl && topEl !== el && !el.contains(topEl)) continue;

            const ref = `e${elements.length + 1}`;
            const role = privagRoleOf(el);
            const name = privagNameOf(el);
            // Role and name let EXECUTE_ACTION find the control again if the page re-renders it meanwhile
            refs.set(ref, { el, role, name });
            const entry = {
                ref,
                role,
                name,
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

// Elements a user can act on, as the scan lists them (top-level functions: safe to redeclare on re-injection)
function privagInteractiveSelector() {
    return 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [contenteditable=""], ' +
        '[contenteditable="true"], [onclick], [role="button"], [role="link"], [role="checkbox"], [role="radio"], ' +
        '[role="switch"], [role="tab"], [role="menuitem"], [role="option"], [role="combobox"], [role="textbox"]';
}

function privagRoleOf(el) {
    if (el.getAttribute('role')) return el.getAttribute('role');
    if (el.localName === 'a') return 'link';
    if (el.localName === 'select') return 'combobox';
    if (el.localName === 'textarea' || el.isContentEditable) return 'textbox';
    if (el.localName === 'input') {
        if (/^(submit|button|reset|image)$/.test(el.type)) return 'button';
        return el.type === 'checkbox' || el.type === 'radio' ? el.type : 'textbox';
    }
    return 'button';
}

function privagNameOf(el) {
    return (el.getAttribute('aria-label')
        || el.labels?.[0]?.innerText
        || el.getAttribute('placeholder')
        || el.getAttribute('title')
        || el.getAttribute('alt')
        || (/^(input|textarea|select)$/.test(el.localName) ? '' : el.innerText)
        || el.querySelector?.('img[alt]')?.getAttribute('alt')
        || (/^(submit|button|reset)$/.test(el.type) ? el.value : '')
        || el.getAttribute('name')
        || el.id
        // A link with no text (logo, icon) is still told apart by where it goes
        || (el.localName === 'a' ? el.getAttribute('href') : '')
        || '').replace(/\s+/g, ' ').trim();
}

// The element behind a ref from the last scan. If the page re-rendered it since (common in React/Vue apps while
// the model was thinking), the same control is found again by role and name, when that is unambiguous.
function privagResolveRef(ref) {
    const entry = window.__privagRefs?.get(ref);
    if (!entry) return null;
    if (entry.el.isConnected) return entry.el;
    const matches = [...document.querySelectorAll(privagInteractiveSelector())].filter((el) =>
        el.getClientRects().length > 0 && privagRoleOf(el) === entry.role && privagNameOf(el) === entry.name);
    return matches.length === 1 ? matches[0] : null;
}
