// Page-side half of the pipeline. The side panel injects validators.js and this file into the active tab with
// chrome.scripting.executeScript and then calls the functions below the same way (executeScript with func),
// so every DOM scan and every action runs through chrome.scripting.executeScript.
// Re-injected before every step: only top-level function declarations (safe to redeclare) and guarded
// window.__privag* state, never top-level const/let.

privagInstallObserver();

// MutationObserver bookkeeping: every DOM change, typed value, scroll or resize bumps a sequence number. The
// side panel waits for the page to be quiet before it scans, and compares the number taken at scan time with
// the one right after the screenshot: if the page changed in between, it scans and captures again, and withholds
// the frame when the page never holds still, so content painted between the scan and the capture (pop-ups,
// toasts, SPA updates) is never sent unmasked.
function privagInstallObserver() {
    if (window.__privagObserver) return;
    window.__privagMutationSeq = 0;
    window.__privagLastChange = performance.now();
    window.__privagObservedRoots = new WeakSet();
    const bump = () => {
        window.__privagMutationSeq++;
        window.__privagLastChange = performance.now();
    };
    window.__privagObserver = new MutationObserver(bump);
    privagObserveRoot(document);
    // Values typed or autofilled, and scrolling, change what is on screen without a DOM mutation
    for (const type of ['input', 'change', 'scroll', 'resize']) window.addEventListener(type, bump, { capture: true, passive: true });
}

// Shadow roots found by the scan are observed too (a document observer does not see inside them)
function privagObserveRoot(root) {
    if (window.__privagObservedRoots.has(root)) return;
    window.__privagObservedRoots.add(root);
    window.__privagObserver.observe(root, { subtree: true, childList: true, characterData: true, attributes: true });
}

function privagMutationSeq() {
    // Records still queued for the observer's callback are changes too
    if (window.__privagObserver.takeRecords().length) {
        window.__privagMutationSeq++;
        window.__privagLastChange = performance.now();
    }
    return window.__privagMutationSeq;
}

// CSS animations, transitions and Web Animations move content without any DOM mutation, so the observer cannot
// see them: they are paused from before the scan until after the screenshot, then resumed. (Once paused and
// resumed from script, an animation no longer follows later animation-play-state changes in the page's CSS.)
function privagFreeze() {
    const running = document.getAnimations().filter((a) => a.playState === 'running');
    for (const a of running) a.pause();
    window.__privagPaused = running;
    return running.length;
}

function privagUnfreeze() {
    for (const a of window.__privagPaused || []) {
        try {
            a.play();
        } catch {
            // the animated element is gone
        }
    }
    window.__privagPaused = [];
}

// Resolves once nothing changed for quietMs (or after maxMs on pages that never settle, e.g. a ticking clock)
async function privagWaitForQuiet(quietMs, maxMs) {
    const start = performance.now();
    while (performance.now() - start < maxMs) {
        privagMutationSeq();
        if (performance.now() - window.__privagLastChange >= quietMs) return { quiet: true, waitedMs: Math.round(performance.now() - start) };
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { quiet: false, waitedMs: Math.round(performance.now() - start) };
}

// The element's shadow root, open or closed (web components hide text and fields from plain queries; content
// scripts may open closed roots). Chromium: chrome.dom.openOrClosedShadowRoot(el), which throws for SVG/MathML
// elements (they cannot host shadow roots anyway; one inline SVG icon used to abort the whole scan). Firefox:
// element.openOrClosedShadowRoot is a property, not a method.
function privagShadowRootOf(el) {
    if (!(el instanceof HTMLElement)) return null;
    if (chrome.dom?.openOrClosedShadowRoot) return chrome.dom.openOrClosedShadowRoot(el);
    if ('openOrClosedShadowRoot' in el) return el.openOrClosedShadowRoot;
    return el.shadowRoot;
}

// The nearest ancestor (or the element itself) matching a selector, crossing shadow-root boundaries, so a link
// or form around a web component is still found
function privagClosestComposed(el, selector) {
    for (let n = el; n; n = n.parentElement || n.getRootNode?.().host) {
        if (n.matches?.(selector)) return n;
    }
    return null;
}

// A stable id per form field, unique to this page: a value read from a field is bound to that field, and a field
// on the next page must never inherit that binding (a new document gets a new prefix)
function privagFieldId(el) {
    window.__privagFieldIds ??= new WeakMap();
    window.__privagFieldCount ??= 0;
    window.__privagDocId ??= [...crypto.getRandomValues(new Uint32Array(2))].map((n) => n.toString(36)).join('');
    let id = window.__privagFieldIds.get(el);
    if (!id) {
        id = `${window.__privagDocId}:f${++window.__privagFieldCount}`;
        window.__privagFieldIds.set(el, id);
    }
    return id;
}

// What a field is for, from its type, HTML autocomplete token and labels, whatever its value looks like.
// Names are split into words first (otp_code, txtOTP, cardCvv). PAN needs a word match: a plain substring would
// flag fields like "company"; a bare "PIN" is a postal code in India, so only named PINs count as secrets.
function privagFieldPurpose(el) {
    const label = el.labels?.[0]?.innerText || '';
    const raw = `${el.name || ''} ${el.id || ''} ${el.getAttribute('placeholder') || ''} ${el.getAttribute('aria-label') || ''} ${label}`;
    const hint = raw.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_.-]+/g, ' ').toLowerCase();
    // The last autocomplete token is the field name ("shipping email", "section-pay cc-number")
    const autocomplete = (el.getAttribute('autocomplete') || '').toLowerCase().trim().split(/\s+/).pop();
    window.__privagPasswordFields ??= new WeakSet();
    // A password field stays one when the page shows it in plain text ("Show password")
    if (el.type === 'password' || window.__privagPasswordFields.has(el) || autocomplete === 'current-password' ||
        autocomplete === 'new-password' || /\b(password|passwd|pwd)\b|\bm ?pin\b|\b(upi|atm|card|security|transaction|txn|login) pin\b/.test(hint)) {
        window.__privagPasswordFields.add(el);
        return 'password';
    }
    if (autocomplete === 'one-time-code' || /\botp\b|one ?time|verification code|passcode/.test(hint)) return 'otp';
    if (autocomplete === 'cc-csc' || /\b(cvv|cvc|csc)\b|security code|card code/.test(hint)) return 'cvv';
    if (autocomplete === 'cc-number') return 'card';
    if (/^cc-(name|given-name|family-name)$/.test(autocomplete)) return 'name';
    // Expiry and the other card fields: hidden without a placeholder
    if (autocomplete.startsWith('cc-')) return 'card_meta';
    if (/aadha?ar|adhaa?r/.test(hint)) return 'aadhaar';
    if (/\bpan\b/.test(hint)) return 'pan';
    if (/\b(upi|vpa)\b/.test(hint)) return 'upi';
    if (/\bifsc\b/.test(hint)) return 'ifsc';
    if (el.type === 'email' || autocomplete === 'email' || /e ?mail/.test(hint)) return 'email';
    if (el.type === 'tel' || autocomplete.startsWith('tel') || /phone|mobile/.test(hint)) return 'phone';
    if (/^(name|given-name|family-name|additional-name|nickname)$/.test(autocomplete) ||
        /\b(full|first|last|middle) ?name\b|\bsurname\b/.test(hint)) return 'name';
    return null;
}

// Purposes whose value never leaves the field: it is not even read, the field is just blacked out
function privagIsSecretPurpose(purpose) {
    return purpose === 'password' || purpose === 'otp' || purpose === 'cvv' || purpose === 'card_meta';
}

// Browsers show an autofilled value before handing it to page scripts (.value can read as ''), so an
// autofilled field is masked whatever .value says
function privagIsAutofilled(el) {
    for (const selector of [':autofill', ':-webkit-autofill']) {
        try {
            if (el.matches(selector)) return true;
        } catch {
            // selector not supported by this browser
        }
    }
    return false;
}

// Pass 1: deterministic DOM scan. Returns, in screenshot pixels (CSS px x devicePixelRatio, the scale
// captureVisibleTab captures at):
//  - regions: PII found in the exact DOM text, form fields and profile photos (OCR misreads don't matter).
//    A region with text gets a placeholder; one without text (secrets, free text holding PII) is blacked out.
//  - elements: interactive elements with refs the model can target (Set-of-Marks)
//  - mediaRegions: images, video, canvas, frames and CSS background images -- the only places left where PII
//    can appear outside DOM text, so the only places the vision model still has to look. Frames and embedded
//    documents are marked unscannable: the DOM pass cannot read inside them.
//  - seq: the mutation sequence number the scan saw
function privagScan() {
    const start = performance.now();
    const dpr = window.devicePixelRatio || 1;
    const regions = [];

    const inViewport = (r) => r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 &&
        r.top < window.innerHeight && r.left < window.innerWidth;

    // The on-screen part of a viewport rect, in screenshot pixels (null when off-screen)
    const toShot = (rect) => {
        const x1 = Math.max(0, rect.left);
        const y1 = Math.max(0, rect.top);
        const x2 = Math.min(window.innerWidth, rect.right);
        const y2 = Math.min(window.innerHeight, rect.bottom);
        if (x2 - x1 < 1 || y2 - y1 < 1) return null;
        return { x: x1 * dpr, y: y1 * dpr, w: (x2 - x1) * dpr, h: (y2 - y1) * dpr };
    };

    // The real text goes only as far as the side panel, which swaps it for the vault's fake (or a black box)
    // before anything leaves it. Secret fields carry no text at all.
    const addRegion = (rect, type, source, text, fieldId) => {
        const bbox = toShot(rect);
        if (!bbox) return false;
        regions.push({ type, source, bbox, ...(text !== undefined && { text }), ...(fieldId && { fieldId }) });
        return true;
    };

    // 0. One pass over every element: find shadow roots, on-screen visual media and profile photos. Small square
    //    images are icons; a wide and thin image or canvas (a line of drawn text) is still sent to vision.
    const roots = [document];
    const mediaRegions = [];
    const PROFILE_HINT = /avatar|profile|user[-_ ]?(photo|pic|image|img)|headshot|portrait|\bdp\b/i;
    for (let i = 0; i < roots.length; i++) {
        for (const el of roots[i].querySelectorAll('*')) {
            const shadow = privagShadowRootOf(el);
            if (shadow) {
                roots.push(shadow);
                privagObserveRoot(shadow);
            }
            const rect = el.getBoundingClientRect();
            if (rect.width < 8 || rect.height < 8 || (rect.width < 32 && rect.height < 32) || !inViewport(rect)) continue;
            const frame = /^(iframe|frame|embed|object)$/.test(el.localName);
            const picture = /^(img|video|canvas|image)$/.test(el.localName) || getComputedStyle(el).backgroundImage.includes('url(');
            if (!frame && !picture) continue;
            const bbox = toShot(rect);
            if (!bbox) continue;
            // Profile photos are solid-masked deterministically, so vision does not need to look at them;
            // every other picture is left to the vision model's face detection and OCR
            const hint = `${el.getAttribute('alt') || ''} ${el.getAttribute('class') || ''} ${el.id || ''} ${el.getAttribute('src') || ''}`;
            if (picture && PROFILE_HINT.test(hint)) regions.push({ type: 'profile_photo', source: 'dom_media', bbox });
            else mediaRegions.push({ ...bbox, unscannable: frame });
        }
    }

    // 1. Visible text: text nodes are grouped by their nearest block-level ancestor and validated as one string,
    //    so a value split across inline elements (<b>2345</b> 6789 0124) is still found. Line breaks, images and
    //    inline-block boxes end a group, and every text node is also checked on its own, so values glued to their
    //    neighbours (<span>Mobile</span><span>9123456789</span>) are found too. Each match is boxed exactly with a
    //    Range, which may span several nodes and lines.
    const displays = new Map();
    const blockOf = (node) => {
        for (let el = node.parentElement; el; el = el.parentElement) {
            let display = displays.get(el);
            if (display === undefined) {
                display = getComputedStyle(el).display;
                displays.set(el, display);
            }
            if (display !== 'inline' && display !== 'contents') return el;
        }
        return node.getRootNode();
    };
    const walkFilter = {
        acceptNode: (node) => {
            if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
            if (/^(script|style|noscript|template|textarea|select|option)$/.test(node.localName)) return NodeFilter.FILTER_REJECT;
            // Elements that break the flow of text are returned only to end the current group
            return /^(br|hr|img|input|button|iframe|canvas|video|svg)$/.test(node.localName) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
        },
    };
    const boxMatch = (match, at) => {
        const range = document.createRange();
        range.setStart(...at(match.start, false));
        range.setEnd(...at(match.end, true));
        // A match spanning several inline boxes yields one rect per box, of different heights: merge the
        // rects of each line into one box so no strip between them stays unmasked
        const lines = [];
        for (const r of range.getClientRects()) {
            if (r.width <= 0 || r.height <= 0) continue;
            const line = lines.find((l) => Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top) >= Math.min(l.bottom - l.top, r.height) / 2);
            if (line) {
                line.left = Math.min(line.left, r.left);
                line.top = Math.min(line.top, r.top);
                line.right = Math.max(line.right, r.right);
                line.bottom = Math.max(line.bottom, r.bottom);
            } else {
                lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
            }
        }
        for (const l of lines) {
            addRegion({ ...l, width: l.right - l.left, height: l.bottom - l.top }, match.type, 'dom_text', match.value);
        }
    };
    // Text shown in capitals by CSS is checked in capitals too (a PAN typed in lowercase still shows as a PAN)
    const asShown = (text, block) => {
        if (!(block instanceof Element) || getComputedStyle(block).textTransform !== 'uppercase') return text;
        const upper = text.toUpperCase();
        return upper.length === text.length ? upper : text;
    };
    const scanGroup = (nodes, block) => {
        const text = asShown(nodes.map((n) => n.nodeValue).join(''), block);
        if (text.trim().length < 4) return;
        const starts = [];
        let pos = 0;
        for (const n of nodes) {
            starts.push(pos);
            pos += n.nodeValue.length;
        }
        const at = (offset, isEnd) => {
            for (let k = 0; k < nodes.length; k++) {
                const len = nodes[k].nodeValue.length;
                if (offset < starts[k] + len || (isEnd && offset === starts[k] + len)) return [nodes[k], offset - starts[k]];
            }
            const last = nodes[nodes.length - 1];
            return [last, last.nodeValue.length];
        };
        const matches = PrivagValidators.find(text);
        if (nodes.length > 1) {
            nodes.forEach((n, k) => {
                for (const m of PrivagValidators.find(text.slice(starts[k], starts[k] + n.nodeValue.length))) {
                    const shifted = { ...m, start: m.start + starts[k], end: m.end + starts[k] };
                    if (!matches.some((g) => shifted.start < g.end && g.start < shifted.end)) matches.push(shifted);
                }
            });
        }
        for (const match of matches) boxMatch(match, at);
    };
    for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, walkFilter);
        let group = [];
        let groupBlock = null;
        const flush = () => {
            if (group.length) scanGroup(group, groupBlock);
            group = [];
        };
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (node.nodeType !== Node.TEXT_NODE) {
                flush();
                continue;
            }
            const block = blockOf(node);
            if (block !== groupBlock) flush();
            groupBlock = block;
            group.push(node);
        }
        flush();
    }

    // 2. Form fields: values are not DOM text, so box the whole field. Secret purposes are never read. A value that
    //    is wholly one PII value, or sits in a field with a purpose, gets a placeholder; any other text that holds
    //    PII (a note with a phone number and an email) is blacked out, so none of it rides along in a fake.
    //    Buttons showing PII in their label, and empty fields showing it in their placeholder, are blacked out too.
    const redactedFields = new Set();
    for (const root of roots) {
        for (const el of root.querySelectorAll('input, textarea, select')) {
            const button = /^(submit|button|reset)$/.test(el.type);
            if (!button && /^(hidden|image|checkbox|radio|file|range|color)$/.test(el.type)) continue;
            const rect = el.getBoundingClientRect();
            if (!inViewport(rect)) continue;
            if (button) {
                const found = PrivagValidators.find(el.value);
                if (found.length) addRegion(rect, found[0].type, 'dom_field', undefined, privagFieldId(el));
                continue;
            }
            const purpose = privagFieldPurpose(el);
            const autofilled = privagIsAutofilled(el);
            let value = el.value;
            if (el.localName === 'select') {
                // The shown option's text is what is on screen (a listbox shows all of them)
                const shown = el.multiple || el.size > 1 ? [...el.options] : [...el.selectedOptions];
                value = shown.map((o) => o.text).join(' ');
            }
            if (!value && !autofilled) {
                const found = PrivagValidators.find(el.getAttribute('placeholder') || '');
                if (found.length && addRegion(rect, found[0].type, 'dom_field', undefined, privagFieldId(el))) redactedFields.add(el);
                continue;
            }
            let type = null;
            let text;
            if (privagIsSecretPurpose(purpose)) {
                type = purpose;
            } else if (PrivagValidators.typeOf(value)) {
                type = PrivagValidators.typeOf(value);
                text = value;
            } else if (purpose) {
                type = purpose;
                text = value;
            } else if (autofilled) {
                type = 'autofill';
            } else {
                type = PrivagValidators.find(value)[0]?.type || null;
            }
            if (!type) continue;
            if (addRegion(rect, type, 'dom_field', text, privagFieldId(el))) redactedFields.add(el);
        }
    }

    // 3. Interactive elements get refs (e1, e2, ...) that the model targets instead of guessing pixel
    //    coordinates (Set-of-Marks). The ref -> element map stays in this isolated world for privagExecute.
    //    Names are returned as shown: the side panel replaces any PII in them with the vault's fakes. Field
    //    values are never included.
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
            // Role and name let privagExecute find the control again if the page re-renders it meanwhile
            refs.set(ref, { el, role, name });
            const entry = {
                ref,
                role,
                name,
                bbox: { x: Math.round(bbox.x), y: Math.round(bbox.y), w: Math.round(bbox.w), h: Math.round(bbox.h) },
            };
            if (entry.role === 'textbox' && 'value' in el) entry.filled = Boolean(el.value) || privagIsAutofilled(el);
            if (redactedFields.has(el)) entry.redacted = true;
            if (el.disabled) entry.disabled = true;
            elements.push(entry);
        }
    }
    window.__privagRefs = refs;

    const seq = privagMutationSeq();
    return {
        regions,
        elements,
        mediaRegions,
        seq,
        // How long the DOM had been still when the scan began: a change made just before the scan may not be on
        // screen yet, so the boxes would describe a page the screenshot does not show
        quietBeforeMs: Math.round(start - window.__privagLastChange),
        scanMs: Math.round(performance.now() - start),
    };
}

// Elements a user can act on, as the scan lists them
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

// The element an action targets, and the point to dispatch at (CSS px). The model answers in screenshot pixels,
// and captureVisibleTab captures at devicePixelRatio (OS scaling x zoom), while elementFromPoint uses CSS px.
// A 'type' never falls back to the focused or first field on the page: no resolved target, no typing.
function privagResolveTarget(data) {
    // Small models write refs loosely ("e7", "[e7]", "E7", a bare 7, or only in "target"): take the number
    const refText = data.ref ?? (/^\W*e\d+\W*$/i.test(String(data.target ?? '')) ? data.target : null);
    const refNumber = refText == null ? null : String(refText).match(/\d+/)?.[0];
    const ref = refNumber ? `e${Number(refNumber)}` : null;
    const refElement = ref ? privagResolveRef(ref) : null;

    const dpr = window.devicePixelRatio || 1;
    let point = Array.isArray(data.coordinates) && data.coordinates.length >= 2
        ? [Number(data.coordinates[0]) / dpr, Number(data.coordinates[1]) / dpr]
        : null;
    if (point && !point.every(Number.isFinite)) point = null;
    if (refElement) {
        refElement.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        const r = refElement.getBoundingClientRect();
        point = [r.left + r.width / 2, r.top + r.height / 2];
    }
    let el = refElement || (!ref && point ? document.elementFromPoint(point[0], point[1]) : null);
    const missing = el ? null
        : ref ? (!window.__privagRefs?.has(ref) ? `No element ${ref} in the last page scan` : `Element ${ref} is no longer on the page`)
        : 'No element at the given coordinates';

    // A ref can point at a wrapper (e.g. a combobox div around its input): type into the field inside
    if (el && data.action === 'type' && !('value' in el) && !el.isContentEditable) {
        el = el.querySelector('input:not([type="hidden"]), textarea, select, [contenteditable=""], [contenteditable="true"]') || el;
    }
    return { el, point, ref, missing };
}

// A plain description of the action's target, for the side panel's gate (action-gate.js) and vault binding.
// A click on an icon or text inside a button counts as a click on that button, and a click on a label as a click
// on its control. A field's type comes only from its purpose (type, autocomplete, labels), never from its current
// value, so the model cannot turn a search box into an "email field" by typing an email into it first.
function privagDescribeTarget(data) {
    const { el, missing } = privagResolveTarget(data);
    if (!el) return { found: false, missing };
    const field = el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select';
    const editable = el.isContentEditable || el.localName === 'textarea' || el.localName === 'select' ||
        (el.localName === 'input' && !/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test(el.type));
    const link = privagClosestComposed(el, 'a[href], area[href]');
    const SUBMITTER = 'button, input[type="submit"], input[type="image"]';
    const labelControl = privagClosestComposed(el, 'label')?.control;
    const submitter = privagClosestComposed(el, SUBMITTER) || (labelControl?.matches?.(SUBMITTER) ? labelControl : null);
    // .type reads 'submit' for a button without a valid type attribute
    const submitsForm = Boolean(submitter?.form) && (submitter.type === 'submit' || submitter.type === 'image');
    // A button's formAction is the page URL when it has no formaction attribute, so the form's action decides then
    const formAction = submitsForm ? (submitter.hasAttribute('formaction') ? submitter.formAction : submitter.form.action) : null;
    // Any other button inside a form that holds values may submit it from script
    const clickable = submitter || privagClosestComposed(el, 'button, [role="button"], input[type="button"]');
    const ownerForm = clickable ? (clickable.form || privagClosestComposed(clickable, 'form')) : null;
    const inFilledForm = !submitsForm && Boolean(ownerForm) && [...ownerForm.elements].some((f) =>
        /^(input|textarea|select)$/.test(f.localName) && !/^(hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/.test(f.type) && f.value);
    return {
        found: true,
        tag: el.localName,
        editable,
        fieldType: field ? privagFieldPurpose(el) : null,
        fieldId: field ? privagFieldId(el) : null,
        href: link ? link.href : null,
        submitsForm,
        formAction,
        inFilledForm,
        label: ((clickable || el).getAttribute('aria-label') || (clickable || el).innerText || (clickable || el).value || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    };
}

// Executes one action the side panel already checked with the gate. For 'type', expectFieldId is the field the
// gate and the vault approved; if the page swapped the element in between, nothing is typed.
// Result messages go back to the server as the model's observation, so they never echo the typed value.
function privagExecute(data) {
    const { action, value } = data;
    const { el, point, ref, missing } = privagResolveTarget(data);

    // Visual pointer ripple for live demonstrations
    const showVisualMarker = (x, y, label) => {
        const marker = document.createElement('div');
        Object.assign(marker.style, {
            position: 'fixed', left: `${x - 15}px`, top: `${y - 15}px`, width: '30px', height: '30px',
            borderRadius: '50%', border: '3px solid #EF4444', backgroundColor: 'rgba(239, 68, 68, 0.3)',
            zIndex: '9999999', pointerEvents: 'none', transition: 'all 0.5s ease-out', boxShadow: '0 0 15px rgba(239, 68, 68, 0.8)',
        });
        if (label) {
            const tag = document.createElement('span');
            tag.textContent = label;
            Object.assign(tag.style, {
                position: 'absolute', bottom: '-20px', left: '50%', transform: 'translateX(-50%)', background: '#1E293B',
                color: '#FFFFFF', padding: '2px 6px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold', whiteSpace: 'nowrap',
            });
            marker.appendChild(tag);
        }
        document.body.appendChild(marker);
        setTimeout(() => {
            marker.style.transform = 'scale(1.8)';
            marker.style.opacity = '0';
        }, 300);
        setTimeout(() => marker.remove(), 800);
    };

    // Assign through the prototype's native setter: React tracks the value on the element itself and would
    // otherwise ignore the input event and drop the typed text
    const setNativeValue = (target, newValue) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), 'value')?.set;
        if (nativeSetter) nativeSetter.call(target, newValue);
        else target.value = newValue;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
    };

    try {
        if (action === 'click') {
            if (!el || !point) return { success: false, message: missing || 'Could not find the element to click' };
            const [x, y] = point;
            showVisualMarker(x, y, `Click: ${ref || data.target || ''}`);
            el.focus?.();
            // The full sequence a real click produces: many menu/dropdown libraries react to pointerdown and
            // never see a bare click()
            const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, pointerType: 'mouse', isPrimary: true };
            el.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1 }));
            el.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
            el.dispatchEvent(new PointerEvent('pointerup', init));
            el.dispatchEvent(new MouseEvent('mouseup', init));
            el.click?.();
            return { success: true, message: ref ? `Clicked ${ref}` : `Clicked element at (${Math.round(x)}, ${Math.round(y)})` };
        }

        if (action === 'type') {
            if (!el) return { success: false, message: missing || 'No editable target' };
            if (data.expectFieldId && privagFieldId(el) !== data.expectFieldId) {
                return { success: false, message: 'The target field changed before typing; nothing was typed' };
            }
            if (point) showVisualMarker(point[0], point[1], `Type: ${ref || data.target || ''}`);

            if (el.localName === 'select') {
                // Pick the option whose visible text or value matches, as a person would
                const wanted = String(value ?? '').trim().toLowerCase();
                const option = [...el.options].find((o) => o.text.trim().toLowerCase() === wanted || o.value.toLowerCase() === wanted);
                if (!option) return { success: false, message: 'No matching option in the dropdown' };
                setNativeValue(el, option.value);
                return { success: true, message: `Selected "${option.text.trim()}"` };
            }
            if (el.isContentEditable) {
                // Rich-text editors (chat boxes, compose windows) only react to real text insertion; execCommand
                // is deprecated but still the one API that inserts text like typing does
                el.focus();
                document.execCommand('selectAll', false);
                document.execCommand('insertText', false, value || '');
                return { success: true, message: 'Typed into target' };
            }
            if ('value' in el) {
                el.focus();
                setNativeValue(el, value || '');
                return { success: true, message: 'Typed into target' };
            }
            return { success: false, message: 'No editable input found' };
        }

        if (action === 'scroll') {
            window.scrollBy({ top: value === 'up' ? -400 : 400, behavior: 'smooth' });
            return { success: true, message: `Scrolled ${value === 'up' ? 'up' : 'down'}` };
        }

        if (action === 'wait' || action === 'done') return { success: true, message: `Action ${action} acknowledged` };
        return { success: false, message: `Unrecognized action: ${action}` };
    } catch (err) {
        return { success: false, message: `Execution error: ${err.message}` };
    }
}
