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
 │     ├─ Gaussian Blur for faces           │               │                        │
 │     └─ Solid Black-Box for text PII      │               │  Output:               │
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
- **Mechanism:** Queries all standard sensitive DOM elements:
  - Passwords: `input[type="password"]`
  - Emails: `input[type="email"]`, `input[name*="email"]`, `input[autocomplete="email"]`
  - Phone Numbers: `input[type="tel"]`, `input[name*="phone"]`, `input[name*="mobile"]`
  - Government IDs: `input[name*="aadhaar"]`, `input[name*="pan"]`, `input[placeholder*="PAN"]`
  - Banking Details: `input[autocomplete="cc-number"]`
- **Output:** Precise pixel coordinates derived from `element.getBoundingClientRect()`.

### 2.2 Pass 2: Florence-2 On-Device Vision Engine

- **Execution Environment:** Chrome Extension Offscreen Document (`offscreen.html`) hosting a dedicated Web Worker (`worker.js`).
- **Acceleration:** Native browser **WebGPU** execution provider via `@huggingface/transformers`.
- **Tasks Executed:**
  1. `<OD>` (Object Detection): Detects human faces, portrait photos, and avatars.
  2. `<OCR_WITH_REGION>`: Detects text rendered in pixels (e.g. text inside canvas banners, scanned identity documents, or non-input paragraphs) and extracts quadrilateral coordinates (`quad_boxes`).
- **Post-Processing:**
  - **NMS Face Merging:** Merges overlapping multi-token face boxes (eyes, nose, head, person) into a single unified bounding box.
  - **Regex PII Filter:** Validates OCR tokens against Indian Aadhaar, PAN card, mobile numbers, and email patterns.

### 2.3 Pass 3: The Canvas Redaction Engine

- **Execution Environment:** HTML5 Canvas 2D Context.
- **Safety Padding:** Automatically adds a $4\text{px}$ horizontal and $3\text{px}$ vertical padding to all bounding boxes to prevent character-edge leakage caused by subpixel antialiasing.
- **Redaction Modes:**
  - **`gaussian_blur`:** Restricts canvas drawing to a clipped path (`ctx.clip()`) and applies `ctx.filter = 'blur(14px)'` over facial regions.
  - **`black_box`:** Occludes sensitive text coordinates with solid black rectangles (`#000000`).
  - **`semantic_mock`:** Replaces DOM values with synthetic placeholders prior to screen rasterization.

---

## 3. The Redaction Manifest Protocol

To ensure the upstream Vision-Language Model can reason about the page structure without hallucinating, the sanitized screenshot is accompanied by a structured metadata manifest:

```json
{
	"timestamp": "2026-09-30T00:15:00Z",
	"page_url": "https://identity-portal.gov.in/verify",
	"screenshot_dimensions": {
		"width": 1920,
		"height": 1080,
		"device_pixel_ratio": 1.25
	},
	"redacted_regions": [
		{
			"id": "redact_0",
			"type": "aadhaar",
			"method": "black_box",
			"source": "florence_ocr",
			"confidence": 0.85,
			"bbox": { "x": 210, "y": 180, "w": 80, "h": 14 }
		},
		{
			"id": "redact_1",
			"type": "face",
			"method": "gaussian_blur",
			"source": "florence_od",
			"confidence": 0.95,
			"bbox": { "x": 595, "y": 133, "w": 105, "h": 148 }
		}
	],
	"dom_structure": {
		"visible_buttons": ["SUBMIT", "CANCEL", "HELP"],
		"form_fields": [
			{ "name": "aadhaar_field", "type": "text", "redacted": true },
			{ "name": "applicant_name", "type": "text", "redacted": false }
		]
	}
}
```

---

## 4. Upstream Server-Side VLM Interface

The server acts as a stateless, model-agnostic controller. It translates the visual interface and manifest into the standard OpenAI Multimodal Chat Completion format:

1. **System Prompt Grounding:** Informs the model that black boxes and blurred regions represent confidential user data and must not be guessed.
2. **Action Grammar:** Constrains the VLM's output to strict, parseable JSON actions:
   ```json
   {
     "action": "click" | "type" | "scroll" | "wait" | "done",
     "target": "Element description or button label",
     "coordinates": [x, y],
     "value": "Text to type or scroll direction"
   }
   ```
3. **Regex Extraction Fallback:** In the event that conversational models wrap their response in Markdown prose, the server executes regex boundary matching (`r'\{.*\}'`) to guarantee reliable JSON extraction.
