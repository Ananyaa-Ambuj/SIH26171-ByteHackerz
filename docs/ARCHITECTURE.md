# Privag AI — System Architecture

## Overview

A browser agent normally streams raw screenshots to a server-side model. Privag AI splits the agent in two: everything that sees raw pixels or raw text runs inside the browser extension, and the server only ever receives a masked frame, a redaction manifest, a masked task and a masked action history. The server plans one action per step; the extension checks it locally and executes it.

---

## 1. System boundary

```text
  USER DEVICE (browser extension)                                SERVER (Flask)
 ┌───────────────────────────────────────────────────┐        ┌──────────────────────────┐
 │ 1. captureVisibleTab()  raw PNG (never leaves)     │        │                          │
 │ 2. Pass 1 DOM scan (content.js + validators.js)    │ masked │  Gemma 4 (vLLM / Ollama) │
 │ 3. Pass 2 Florence-2 on media only (Web Worker)    │ frame, │  via an OpenAI-compatible│
 │ 4. Pass 3 canvas masks (offscreen.js)              │ manif- │  endpoint                │
 │      black_box | solid_mask | semantic_mock        │ est,   │                          │
 │ 5. Manifest schema check, masked task + history ───┼──────► │  validates input, asks   │
 │                                                    │        │  the VLM, validates the  │
 │ 7. Local action gate + vault (action-gate.js,      │ ◄──────┼─ one JSON action         │
 │    pii-masker.js), then executeScript()            │ action │                          │
 └───────────────────────────────────────────────────┘        └──────────────────────────┘
```

What never crosses: the raw screenshot, field values, page text, the real values behind placeholders, OCR text.

---

## 2. Components

### 2.1 Pass 1: DOM scan (`extension/content.js`, `extension/validators.js`)

Injected into the task's tab with `chrome.scripting.executeScript`; the side panel then calls its functions the same way.

1. **Visible text.** Text nodes are grouped by their nearest block-level element and validated as one string, so a value split over inline elements (`<b>2345</b> 6789 0124`) is still found. Each match is boxed with a `Range` (one box per line).
2. **Validators, not regexes.** A candidate pattern only proposes a span; the type's validator decides: Aadhaar (12 digits, first digit 2-9, Verhoeff check digit), card numbers (13-19 digits, Luhn), PAN (`AAAAA9999A` with a valid holder-type letter), Indian mobile numbers (optional `+91`/`0`, first digit 6-9), UPI IDs (`handle@psp`, no dot in the PSP part), IFSC (`AAAA0XXXXXX`), emails, and OTPs only when an OTP label precedes the digits. A number that fails its checksum is left alone.
3. **Form fields by purpose.** Password inputs, `autocomplete` tokens (`one-time-code`, `cc-number`, `cc-csc`, other `cc-*`, `tel*`, `email`, `name`, …) and name/id/label hints (Aadhaar, PAN, UPI/VPA, IFSC, OTP, CVV, phone, email, full name) decide a field's type whatever its value. Passwords, OTPs, CVVs and other card fields are never read: the field is just blacked out. Fields the browser autofilled are masked even when the page cannot read their value yet, and a `<select>` is masked when the option it shows is PII.
4. **Profile photos.** Images whose `alt`/class/id/src mention an avatar or profile photo get a solid mask without waiting for vision.
5. **Media for Pass 2.** Images, video, canvas and CSS background images are reported for vision; iframes, frames, embeds and objects (including PDFs, which the browser shows inside an embed) are reported as *unscannable*, because the DOM pass cannot read inside them.
6. **Interactive elements.** Buttons, links, fields and ARIA widgets in view get refs (`e1`, `e2`, …) that the model targets instead of guessing pixels. Their names go through the same vault as everything else.
7. **MutationObserver.** A sequence number is bumped on every DOM mutation (open and closed shadow roots included), input, scroll and resize. Before a scan the side panel waits until the page has been quiet for a moment; after the screenshot it compares the sequence number with the one the scan saw. If the page changed in between, it scans and captures again; a page that never holds still gets the regions of the scans before *and* after its last screenshot masked.

### 2.2 Pass 2: Florence-2 vision (`client-vision/worker.js` → `extension/florence-worker.bundle.js`)

- Runs in a Web Worker hosted by the offscreen document, through Transformers.js and ONNX Runtime on WebGPU, with a WASM fallback (at load time, and again if a WebGPU inference fails).
- Looks only at the media regions from Pass 1, cut out of the screenshot onto a white canvas. No media on screen means the pass is skipped; media whose pixels are unchanged since a recent step reuses the cached result.
- `<OD>` finds people and faces (overlapping boxes merged); `<OCR_WITH_REGION>` reads text lines. A line is PII when it contains a value that passes a validator, or carries a PII label (Aadhaar, PAN, card, phone, email, UPI, IFSC, OTP) next to a value-looking token, which catches values OCR garbled. Inside unscannable media every OCR line is masked.

### 2.3 Pass 3: canvas masks (`extension/offscreen.js`)

| Method | Applied to | Drawn as |
| :--- | :--- | :--- |
| `black_box` | passwords, OTPs, CVV/card fields, card numbers, Aadhaar, PAN; text PII in images; every OCR line inside frames and embeds | solid `#000000`, padded 4 px / 3 px |
| `solid_mask` | faces (Florence `<OD>`) and profile photos (DOM rule) | solid grey `#7f7f7f` (no blur) |
| `semantic_mock` | emails, phone numbers, UPI IDs, IFSC codes, names | a format-preserving fake on the page's own background colour |

Masks are drawn first and fakes last, then the Set-of-Marks ref tags. Black-boxed card and ID numbers still carry a placeholder in the manifest (`value`), so the model can type them without seeing them.

### 2.4 The vault (`extension/pii-masker.js`)

The side panel's in-memory map between real values and placeholders. Fakes are clearly synthetic: Aadhaar `0000 0000 0001` (real ones never start with 0), PAN `ZZZZZ0001Z` (Z is not a holder type), card `4111 1111 1111 0001`, phone `90000 00001`, email `user_0001@example.com`, UPI `user_0001@fakebank`, IFSC `ZZZZ0000001`, name `Test User 0001`. Every text that leaves the device goes through it: element names, the task (where `{{…}}` marks other secrets) and the action history.

Each fake remembers where its real value came from. When the model types a fake, the real value is restored only **into the field it was read from**, or, for a value from the task or the page text, **into a field whose detected purpose matches its type** (a PAN into a PAN field). Anywhere else the action is blocked and the model is told why. The vault lives as long as the task.

### 2.5 The action gate (`extension/action-gate.js`)

Every action from the server is checked on the device against a description of its target element before anything touches the page:

- typing into password, OTP or CVV fields is blocked (the user enters those);
- a link or form submission to another site is blocked (same site = same host without `www.`, or a subdomain of the start host);
- anything that submits a form or is labelled like a payment (`Pay`, `Place order`, `Submit`, `Confirm`, …) waits for the user's **Allow once** click in the side panel;
- only the action fields the extension knows are used, so a reply cannot smuggle in flags.

### 2.6 The agent loop (`extension/sidepanel.js`)

"Run Agent" pins a task to the active tab and repeats: sanitize → POST `/api` → gate + vault → `chrome.scripting.executeScript` → wait for the page to settle.

- **Pauses** (vault kept, Resume continues): switching to another tab, the tab leaving the start site, the vision model still loading (resumes by itself when ready), a server or LLM error, 3 steps in a row without progress, 15 steps without finishing.
- **Ends** (vault cleared): the model answers `done`, Stop, Clear, a new task, or the task's tab is closed.

### 2.7 Fail-closed rules

A frame is **withheld** (nothing is sent) when the DOM pass cannot run on the page (browser-internal and store pages, injection errors), when vision is needed but the model is not loaded or fails or times out, when the active tab changes during capture, or when the manifest fails its schema check (`extension/redaction-manifest.js`). Florence-2 gives no calibrated confidence, so "low confidence" is handled structurally: text in regions the DOM pass cannot read is masked line by line, and labelled lines whose value OCR garbled are masked too.

---

## 3. Redaction manifest

Sent with every frame and validated on both sides (allow-listed keys only):

```json
{
  "redacted_regions": [
    { "type": "face", "method": "solid_mask", "source": "florence_od", "bbox": { "x": 390, "y": 402, "w": 241, "h": 300 } },
    { "type": "profile_photo", "method": "solid_mask", "source": "dom_media", "bbox": { "x": 264, "y": 553, "w": 120, "h": 150 } },
    { "type": "aadhaar", "method": "black_box", "source": "dom_text", "value": "0000 0000 0001", "bbox": { "x": 123, "y": 96, "w": 159, "h": 25 } },
    { "type": "password", "method": "black_box", "source": "dom_field", "bbox": { "x": 278, "y": 256, "w": 244, "h": 35 } },
    { "type": "upi", "method": "semantic_mock", "source": "dom_text", "value": "user_0001@fakebank", "bbox": { "x": 404, "y": 176, "w": 185, "h": 25 } },
    { "type": "email", "method": "semantic_mock", "source": "dom_field", "value": "user_0002@example.com", "bbox": { "x": 28, "y": 305, "w": 244, "h": 35 } }
  ],
  "screenshot_dimensions": { "width": 1262, "height": 910 },
  "dom_structure": {
    "elements": [
      { "ref": "e2", "role": "textbox", "name": "Password", "filled": true, "redacted": true, "bbox": { "x": 278, "y": 256, "w": 244, "h": 35 } },
      { "ref": "e8", "role": "button", "name": "Pay now", "bbox": { "x": 28, "y": 728, "w": 97, "h": 35 } }
    ]
  }
}
```

(An excerpt of a manifest produced by the extension on a test page.)

Methods: `black_box`, `solid_mask`, `semantic_mock`. Sources: `dom_text`, `dom_field`, `dom_media`, `florence_od`, `florence_ocr`.

---

## 4. Server

A Flask app (`server/app.py`) that validates the request (JSON object, masked task, data-URL image, history list, manifest schema), forwards it to an OpenAI-compatible endpoint serving Gemma 4 (default: Ollama `gemma4:31b-it-q4_K_M`; vLLM: `google/gemma-4-31B-it`), and validates the reply into exactly one action: `{"action": "click|type|scroll|wait|done", "ref", "target", "coordinates", "value", "thought"}`. The system prompt tells the model what each mask means and never to guess masked content. Endpoints, status codes and configuration are in [`API.md`](API.md).

---

## 5. Known limitations

- Names in free page text are not detected (on-device NER is planned); name *fields* are masked.
- Text drawn by CSS (`::before`/`::after` content) is not read by the DOM pass.
- Florence-2 sees each crop resized to its input size, so small text in a large image or frame can be missed by OCR; such text is then not masked.
- The gate cannot see navigations started by page scripts; the loop notices them afterwards (the tab left the start site) and pauses.
- Firefox: see the README's status table.
