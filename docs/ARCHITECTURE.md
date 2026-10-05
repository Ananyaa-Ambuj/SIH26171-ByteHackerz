# Privag AI — System Architecture

## Overview

A browser agent normally streams raw screenshots to a server-side model. Privag AI splits the agent in two: everything that sees raw pixels or raw text runs inside the browser extension, and the server only ever receives a masked frame, a redaction manifest, a masked task and a masked action history. The server plans one action per step; the extension checks it locally and executes it.

The vision model is the expensive part of a step, so it runs only where the DOM pass cannot read: on the images, video, canvas, frames and embedded PDFs on screen, and only when their pixels have changed. A step with no such media skips it; a step whose media is unchanged reuses the earlier result. Measured costs of each case are in [`BENCHMARKS.md`](BENCHMARKS.md#1-conditional-vision).

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

1. **Visible text.** Text nodes are grouped by their nearest block-level element and validated as one string, so a value split over inline elements (`<b>2345</b> 6789 0124`) is still found. Line breaks, images and inline-block boxes end a group, and every text node is also checked on its own, so a value glued to its neighbour (`<span>Mobile</span><span>9123456789</span>`) is found too. Text that CSS shows in capitals is checked in capitals. Each match is boxed with a `Range` (one box per line).
2. **Validators, not regexes.** A candidate pattern only proposes a span; the type's validator decides: Aadhaar (12 digits, first digit 2-9, Verhoeff check digit), card numbers (13-19 digits, Luhn), PAN (`AAAAA9999A` with a valid holder-type letter), Indian mobile numbers (optional `+91`/`0091`/`0`, first digit 6-9), UPI IDs (`handle@psp`, no dot in the PSP part), IFSC (`AAAA0XXXXXX`), emails, and OTPs only next to an OTP label ("OTP: 482913", "482913 is your OTP"). Numbers are read as runs of digit groups and every stretch of whole groups is tried, so two numbers printed side by side are each found. A number that fails its checksum is left alone.
3. **Form fields by purpose.** Password inputs, `autocomplete` tokens (`one-time-code`, `current-password`, `cc-number`, `cc-csc`, other `cc-*`, `tel*`, `email`, `name`, …) and name/id/label hints, split into words first (`otp_code`, `txtCVV`, `upiPin`), decide a field's type whatever its value. Passwords, OTPs, CVVs, PINs and other card fields are never read: the field is just blacked out, and a password field stays one after "show password". A value that is wholly one PII value, or sits in a field with a purpose, gets a placeholder; any other text holding PII (a note with a phone number and an email) is blacked out without being read. Autofilled fields are masked even when the page cannot read their value yet; a `<select>` is masked when the option it shows is PII; PII in a placeholder or a button label is blacked out.
4. **Profile photos.** Images whose `alt`/class/id/src mention an avatar or profile photo get a solid mask without waiting for vision.
5. **Media for Pass 2.** Images, video, canvas and CSS background images (except small square icons; a wide, thin canvas with a line of text still counts) are reported for vision; iframes, frames, embeds and objects (including PDFs, which the browser shows inside an embed) are reported as *unscannable*, because the DOM pass cannot read inside them.
6. **Interactive elements.** Buttons, links, fields and ARIA widgets in view get refs (`e1`, `e2`, …) that the model targets instead of guessing pixels. Their names go through the same vault as everything else.
7. **MutationObserver and a still page.** A sequence number is bumped on every DOM mutation (open and closed shadow roots included), input, scroll and resize. CSS animations, transitions and Web Animations, which move content without any mutation, are paused from before the scan until after the screenshot. The side panel waits until the page has been quiet for a moment, scans, captures, and uses the frame only if the DOM was still from 100 ms before the scan until after the screenshot. Otherwise it tries again; after 3 tries the frame is withheld.

### 2.2 Pass 2: Florence-2 vision (`client-vision/worker.js` → `extension/florence-worker.bundle.js`)

- Runs in a Web Worker through Transformers.js and ONNX Runtime on WebGPU, with a WASM fallback (at load time, and again if a WebGPU inference fails). In Chrome/Brave the worker lives in the offscreen document; Firefox has no offscreen API, so the side panel hosts the same page in a hidden iframe.
- Looks only at the media regions from Pass 1, cut out of the screenshot onto a white canvas. No media on screen means the pass is skipped; media whose pixels are unchanged since a recent step reuses the cached result.
- On WASM, ONNX Runtime runs on several threads (up to 4; it takes half the logical cores) only in a cross-origin isolated page. The manifest therefore sets `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin`. As a result, extension pages can only load cross-origin resources that allow it (CORS or `Cross-Origin-Resource-Policy`); today they load none. Firefox does not support these two keys, so its WASM fallback is expected to stay on one thread.
- `<OD>` finds people and faces (overlapping boxes merged); `<OCR_WITH_REGION>` reads text lines. A line is PII when it contains a value that passes a validator, or carries a PII label (Aadhaar, PAN, card, phone, email, UPI, IFSC, OTP) next to a value-looking token, which catches values OCR garbled. Inside unscannable media every OCR line is masked. OCR output is limited to 512 tokens; when a crop needs more, the lines after the cut are never reported, so every media area of that crop is blacked out.

### 2.3 Pass 3: canvas masks (`extension/offscreen.js`)

| Method | Applied to | Drawn as |
| :--- | :--- | :--- |
| `black_box` | passwords, OTPs, CVV/card fields, card numbers, Aadhaar, PAN; free text holding PII; text PII in images; every OCR line inside frames and embeds | solid `#000000`, padded 4 px / 3 px |
| `solid_mask` | faces (Florence `<OD>`) and profile photos (DOM rule) | solid grey `#7f7f7f` (no blur) |
| `semantic_mock` | emails, phone numbers, UPI IDs, IFSC codes, names | a format-preserving fake on the page's own background colour |

Masks are drawn first and fakes last, then the Set-of-Marks ref tags. Black-boxed card and ID numbers still carry a placeholder in the manifest (`value`), so the model can type them without seeing them.

### 2.4 The vault (`extension/pii-masker.js`)

The side panel's in-memory map between real values and placeholders. Fakes are clearly synthetic: Aadhaar `0000 0000 0001` (real ones never start with 0), PAN `ZZZZZ0001Z` (Z is not a holder type), card `4111 1111 1111 0001`, phone `90000 00001`, email `user_0001@example.com`, UPI `user_0001@fakebank`, IFSC `ZZZZ0000001`, name `Test User 0001`. Every text that leaves the device goes through it: element names, the task (where `{{…}}` marks other secrets) and the action history.

Each fake remembers where its real value came from. When the model types a fake (with any spacing or letter case), the real value is restored only **into the field it was read from** (field ids are unique per page, so a field on the next page never inherits the binding), or, for a value from the task or the page text, **into a field whose purpose matches its type** (a PAN into a PAN field). A field's purpose comes from its type, `autocomplete` and labels, never from what is currently typed in it. Anywhere else the action is blocked and the model is told why. The vault lives as long as the task.

### 2.5 The action gate (`extension/action-gate.js`)

Every action from the server is checked on the device against a description of its target element before anything touches the page:

- typing into password, OTP or CVV fields is blocked (the user enters those);
- a link or form submission to another site, or to the Privag server itself, is blocked (same site = same host without `www.` or a subdomain of the start host, on the same port, with the same scheme or an http → https upgrade). A click on text inside a button, a label for it, a `formaction` override and links around shadow-DOM content are all followed to the real target;
- anything that submits a form, is labelled like a payment (`Pay`, `Place your order`, `Submit`, `Confirm`, `भुगतान`, …) or is a button inside a form that already holds values waits for the user's **Allow once** click in the side panel; after the click the target is checked again, and the action runs only on the very element that was allowed;
- only the action fields the extension knows are used, so a reply cannot smuggle in flags.

### 2.6 The agent loop (`extension/sidepanel.js`)

"Run Agent" pins a task to the active tab and repeats: sanitize → POST `/api` → gate + vault → `chrome.scripting.executeScript` → wait for the page to settle.

- **Pauses** (vault kept, Resume continues): switching to another tab, the tab leaving the start site, the vision model still loading (resumes by itself when ready), a server or LLM error, 3 steps in a row without progress, 15 steps without finishing.
- **Asks** (`ask_user`, for a detail only the user can give): the side panel shows the model's question with an answer box and waits; nothing touches the page meanwhile. The answer goes through the vault like the task, so PII in it reaches the server only as placeholders, which become real values only in a matching field; it enters the history as `The user answered: …`. The raw answer is not kept in the panel. Switching tabs does not interrupt the question; the tab is checked again before the next step. Stop or Clear ends the task.
- **Ends** (vault cleared): the model answers `done`, Stop, Clear, a new task, or the task's tab is closed. On `done` the side panel announces the model's `summary` ("Task complete: …") until the next task or Clear.

### 2.7 Fail-closed rules

A frame is **withheld** (nothing is sent) when the DOM pass cannot run on the page (browser-internal and store pages, injection errors), when the page keeps changing between the scan and the screenshot, when vision is needed but the model is not loaded or fails or times out or reports a face or text without a position, when the active tab changes during capture, or when the manifest fails its schema check (`extension/redaction-manifest.js`). Florence-2 gives no calibrated confidence, so "low confidence" is handled structurally: text in regions the DOM pass cannot read is masked line by line, labelled lines whose value OCR garbled are masked too, and media whose OCR was cut off is blacked out whole.

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
- Florence-2 sees each crop resized to its input size, so small text in a large image or frame can be missed by OCR; text OCR does not see is not masked.
- Pages that change faster than every 100 ms (live feeds, script-driven tickers) are withheld on every step, so the agent cannot work on them.
- Pausing animations for the capture overrides the page's own `animation-play-state` for those animations afterwards.
- The gate cannot see navigations started by page scripts; the loop notices them afterwards (the tab left the start site) and pauses.
- Firefox: see the README's status table.
