# Privag AI — SIH26171 evaluation criteria

How the five evaluation criteria of problem statement SIH26171 map to the code, and what has been measured so far. Every figure here comes from [`BENCHMARKS.md`](BENCHMARKS.md), which links the raw output; anything else says **not yet measured**.

---

### 1. Visual context accuracy (25%)

*Does the server-side agent understand the page although regions are masked?*

- **How:** the masked frame comes with a redaction manifest (`type`, `method`, `source`, `bbox` per mask) and the page's interactive elements with refs (`e1`, `e2`, …) drawn on the frame (Set-of-Marks). Values the agent may need are format-preserving look-alikes (`user_0001@example.com`, `90000 00001`) or placeholders for black-boxed IDs, so the model can still fill a form without seeing real values.
- **Measured:** not yet measured. No labelled set of pages was scored, and Gemma 4 was not run in this repository's tests (the end-to-end tests use a mock model).

### 2. PII detection recall and precision (20%)

*How much PII does the device find, and how much harmless text does it mask by mistake?*

- **How:** checksum and structure validators for DOM text and form values (Verhoeff for Aadhaar, Luhn for cards, PAN structure, Indian mobile, UPI, IFSC, labelled OTPs), field purposes from `type`/`autocomplete`/labels, and Florence-2 face detection and OCR on images and frames.
- **Tested:** unit tests and the privacy end-to-end test check specific cases (each PII type on the fixture page is masked, invalid checksums are not).
- **Measured:** recall and precision not yet measured. That needs a labelled test set (for example WebPII), which this repository does not have yet.

### 3. Redaction precision (20%)

*Are the masks complete and tight?*

- **How:** black boxes padded 4 px / 3 px; solid grey masks for faces and profile photos; frames are withheld when the page changes between the scan and the screenshot, so boxes are never drawn on pixels from another moment.
- **Tested:** the privacy end-to-end test checks that every black box and solid mask in the sent image is solid (98% or more of each mask's interior has the mask colour). The race test ([`tests/privacy/race.test.mjs`](../tests/privacy/race.test.mjs)) draws PII in magenta on moving and changing pages and checks that no strongly magenta pixels are left in the sent frames.
- **Measured:** "no PII readable when our own masked frames are run through OCR again" is not yet measured.

### 4. Client-side resource usage (20%)

- **How:** the DOM pass is plain JavaScript; Florence-2 runs only when images, video, canvas or frames are on screen, and unchanged media reuses the previous result. Without WebGPU, the model runs on up to 4 WASM threads.
- **Measured:** a step without vision work took 453 ms (no media on screen) and 433 ms (media unchanged) median, against 3.40–4.35 s when Florence-2 ran on WebGPU. Model download size, model load time from the browser cache and peak memory per browser process are in [`BENCHMARKS.md`](BENCHMARKS.md).

### 5. End-to-end latency (15%)

- **Measured:** per-stage times of real agent steps (settle, DOM scan, capture, vision, masking, server, execute) with a mock model are in [`BENCHMARKS.md`](BENCHMARKS.md). With new images on screen, the Florence-2 pass took 2.96–3.90 s on WebGPU and 29.0 s and 48.1 s on the CPU (4 WASM threads; 93.5 s and 103.1 s on one thread before the threading change).
- **Not yet measured:** Gemma 4 inference time, so a full step with the real model is not yet measured.
