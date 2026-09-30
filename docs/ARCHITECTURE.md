# Privag AI — System Architecture Specification

## Overview

Privag AI is architected to solve a foundational security vulnerability in autonomous web agents: **the exfiltration of sensitive screen data to cloud reasoning engines**.

By decoupling visual perception into an **on-device privacy boundary** and an **external reasoning boundary**, sensitive tokens never traverse the network.

---

## 1. System Boundary Design

```text
  USER DEVICE (Zero-Knowledge Zone)              NETWORK         REASONING SERVER
 ┌──────────────────────────────────────────┐               ┌────────────────────────┐
 │                                          │               │                        │
 │  1. Content Script (DOM Scanner)         │               │  Model-Agnostic VLM    │
 │     └─ HTML attributes & field bounding  │               │  (Gemma / Qwen)        │
 │                                          │   HTTP POST   │                        │
 │  2. Offscreen Worker (Florence-2 WebGPU) │  ───────────► │  Input:                │
 │     └─ Visual faces & unstructured OCR   │   Sanitized   │   - Sanitized image    │
 │                                          │   Image +     │   - Redaction manifest │
 │  3. Native Canvas 2D Engine              │   Manifest    │   - User task string   │
 │     ├─ Look-alike fakes for DOM PII      │               │                        │
 │     ├─ Black box for text in images      │               │                        │
 │     └─ Gaussian blur for faces           │               │  Output:               │
 │                                          │   Action JSON │   - Action JSON        │
 │  4. Action Execution Engine              │  ◄─────────── │     (click/type/scroll)│
 │     └─ Dispatches synthetic click/events │               │                        │
 └──────────────────────────────────────────┘               └────────────────────────┘
```

---

## 2. Component Breakdown

### 2.1 Pass 1: The Deterministic DOM Scanner

- **Execution Environment:** Injected Content Script (`content.js`).
- **Runtime:** $<20\text{ms}$ execution latency, 0 MB GPU VRAM.
- **Mechanism** (open and closed shadow DOM included):
  1. **Visible page text:** Runs exact card, Aadhaar, mobile-number, PAN and email patterns (in that priority, so a card number is never split into an Aadhaar number) over every visible DOM text node and boxes each match with a `Range`, so PII rendered as HTML text never depends on OCR accuracy.
  2. **Form fields:** Every non-empty field that is sensitive by purpose, or whose value matches a PII pattern:
     - Passwords: `input[type="password"]`
     - Emails: `type="email"`, `autocomplete="email"`, or "email" in the name / id / placeholder / aria-label
     - Phone Numbers: `type="tel"`, `autocomplete="tel*"`, or "phone" / "mobile" in those attributes
     - Government IDs: "aadhaar" in those attributes, or "PAN" as a whole word (so fields such as `company` are not caught)
     - Banking Details: `autocomplete="cc-number"`; other `cc-*` fields (security code, expiry) are hidden like passwords
  3. **Interactive elements:** Buttons, links, fields and ARIA widgets in the viewport (not covered by overlays) get refs `e1`, `e2`, … that the model targets instead of guessing pixel coordinates (`dom_structure.elements`). Names are faked with the same vault as the image; field values are never included.
  4. **Visual media:** Images, video, canvases, frames and CSS background images in the viewport, the only places PII can appear outside DOM text, are reported so Pass 2 only looks there.
- **Output:** Pixel boxes from `getClientRects()` / `getBoundingClientRect()`, scaled by `devicePixelRatio` into screenshot pixels. Every DOM detection becomes a `semantic_mock` region (`source: "dom_text"` / `"dom_field"`); its real text goes only as far as the side panel, which swaps it for the vault's fake.

### 2.2 Pass 2: Florence-2 On-Device Vision Engine

- **Execution Environment:** Chrome Extension Offscreen Document (`offscreen.html`) hosting a dedicated Web Worker (`worker.js`).
- **Acceleration:** Native browser **WebGPU** execution provider via `@huggingface/transformers`.
- **Scope:** Only the visual media reported by Pass 1, cut out of the screenshot onto a white canvas (DOM PII inside them whited out, as Pass 1 already fakes it). No media on screen means the pass is skipped; media identical to a recent step (same pixels, by SHA-256) reuses the cached result. Without a DOM scan (pages that block content scripts) the whole screenshot is analysed.
- **Tasks Executed:**
  1. `<OD>` (Object Detection): Detects human faces, portrait photos, and avatars.
  2. `<OCR_WITH_REGION>`: Detects text rendered in pixels (e.g. text inside canvas banners, scanned identity documents, or non-input paragraphs) and extracts quadrilateral coordinates (`quad_boxes`).
- **Post-Processing:**
  - **NMS Face Merging:** Merges overlapping multi-token face boxes (eyes, nose, head, person) into a single unified bounding box.
  - **Regex PII Filter:** Validates OCR tokens against Indian Aadhaar, PAN card, mobile numbers, and email patterns.
  - **Label Context Rule:** An OCR line holding a PII label (Aadhaar, PAN, phone/mobile, email) plus a value-like token (3+ digits or an `@`) is redacted even when OCR garbled the value, e.g. `PAN Card: ABCDE123RF`. Bare labels such as "PAN Number" stay visible for the agent.

### 2.3 Pass 3: The Canvas Redaction Engine

- **Execution Environment:** HTML5 Canvas 2D Context.
- **Safety Padding:** Automatically adds a $4\text{px}$ horizontal and $3\text{px}$ vertical padding to text bounding boxes to prevent character-edge leakage caused by subpixel antialiasing.
- **Redaction Modes** (the region's own `method` always decides; DOM → fake, image → black box or blur):
  - **`semantic_mock`** (all DOM detections): Draws a format-preserving, clearly synthetic fake over the real value, on the page's own background colour: Aadhaar `0000 0000 0001` (original spacing), PAN `ZZZZZ0001Z`, phone `90000 00001`, card `4111 1111 1111 0001`, email `user_0001@example.com`, passwords as a fixed `••••••••`. Fakes come from the side panel's vault (`pii-masker.js`): fixed-width numbering, the same fake for the same value all run.
  - **`black_box`** (text PII inside images, from Florence OCR): Occludes it with solid black rectangles (`#000000`).
  - **`gaussian_blur`** (faces, from Florence OD): Restricts canvas drawing to a clipped path (`ctx.clip()`) and applies `ctx.filter = 'blur(14px)'`.
- **Draw Order:** Vision regions first, DOM fakes last, so no black box or blur can cover a fake value; Set-of-Marks ref tags go on top.
- **Beyond the Image:** The same vault fakes PII in element names and in the user's task text (secrets without a recognisable format can be marked `{{…}}`), and fakes the model types are swapped back to the real values locally, right before execution. The action history sent back to the server only ever holds fakes.

---

## 3. The Redaction Manifest Protocol

To ensure the upstream Vision-Language Model can reason about the page structure without hallucinating, the sanitized screenshot is accompanied by a structured metadata manifest:

```json
{
	"redacted_regions": [
		{
			"type": "aadhaar",
			"method": "semantic_mock",
			"source": "dom_text",
			"value": "0000 0000 0001",
			"bbox": { "x": 217, "y": 129, "w": 217, "h": 33 }
		},
		{
			"type": "password",
			"method": "semantic_mock",
			"source": "dom_field",
			"value": "••••••••",
			"bbox": { "x": 40, "y": 373, "w": 212, "h": 27 }
		},
		{
			"type": "pan",
			"method": "black_box",
			"source": "florence_ocr",
			"bbox": { "x": 925, "y": 316, "w": 270, "h": 36 }
		},
		{
			"type": "face",
			"method": "gaussian_blur",
			"source": "florence_od",
			"bbox": { "x": 595, "y": 133, "w": 105, "h": 148 }
		}
	],
	"screenshot_dimensions": { "width": 1580, "height": 1014 },
	"dom_structure": {
		"elements": [
			{ "ref": "e1", "role": "textbox", "name": "Aadhaar Number", "filled": true, "redacted": true, "bbox": { "x": 40, "y": 373, "w": 212, "h": 27 } },
			{ "ref": "e2", "role": "button", "name": "Submit", "bbox": { "x": 40, "y": 486, "w": 160, "h": 64 } }
		]
	}
}
```

---

## 4. Upstream Server-Side VLM Interface

The server acts as a stateless, model-agnostic controller. It translates the visual interface and manifest into the standard OpenAI Multimodal Chat Completion format:

1. **System Prompt Grounding:** Informs the model that look-alike values (e.g. `ZZZZZ0001Z`), black boxes and blurred regions stand in for confidential user data. Look-alikes may be reused exactly as given (the extension restores the real value locally); redacted content must never be guessed.
2. **Action Grammar:** Constrains the VLM's output to strict, parseable JSON actions, with a short reasoning trace first (ReAct):
   ```json
   {
     "thought": "Brief reasoning about the page and why this action is next",
     "action": "click" | "type" | "scroll" | "wait" | "done",
     "ref": "e7",
     "target": "Element description or button label",
     "coordinates": [x, y],
     "value": "Text to type (look-alikes as given), dropdown option, or scroll direction"
   }
   ```
   `ref` (a Set-of-Marks tag drawn on the screenshot) is the exact way to target an element; `coordinates` are only a fallback for things without a ref.
3. **Regex Extraction Fallback:** In the event that conversational models wrap their response in Markdown prose, the server executes regex boundary matching (`r'\{.*\}'`) to guarantee reliable JSON extraction.

## 5. The Agent Loop (Side Panel)

"Run Agent" repeats **observe → reason + act → execute** until the task is finished:

1. **Observe:** Pass 1 + Pass 2 sanitize a fresh screenshot of the active tab; PII in the task text is faked with the same vault.
2. **Reason + act:** The server returns one action with its `thought`.
3. **Execute:** Look-alikes in the action's `value` are swapped back to the real values locally, then `content.js` performs it on the ref'd element. The outcome (e.g. `Clicked e7` or `Element e7 is no longer on the page`), masked like everything else, is appended to the history as the observation the model reads next turn.
4. **Settle:** The loop waits for re-renders and any navigation to finish, then observes again.

It stops on `"done"`, the Stop button, 15 steps, 3 consecutive steps without progress (failed or `wait` actions), or when the server reports that the LLM is unreachable. A failed redaction aborts the run, so nothing unsanitized is ever sent.
