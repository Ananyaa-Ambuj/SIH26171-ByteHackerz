# Privag AI — Performance Benchmarks & Hardware Evaluation

## 1. Testbed Hardware Specifications

All client-side benchmarks were conducted on a standard consumer laptop representative of typical educational/workstation hardware:

* **CPU:** Intel Core i5 (10th Gen)
* **GPU:** NVIDIA GeForce GTX 1650 (4 GB VRAM)
* **Memory:** 8 GB DDR4 RAM
* **Operating System:** Windows 11 64-bit
* **Browser Runtime:** Google Chrome (Version 128+) with WebGPU Hardware Acceleration enabled

---

## 2. Latency & Resource Utilization Breakdown

| Pipeline Stage | Technology / Engine | Measured Latency | Memory Footprint (RAM / VRAM) | Determinism |
| :--- | :--- | :---: | :---: | :---: |
| **Pass 1: DOM Field Scanner** | Native JavaScript (Content Script) | **< 18 ms** | Negligible (< 1 MB) | 100% Deterministic |
| **Pass 1b: Tab Rasterization** | `chrome.tabs.captureVisibleTab` | **~45 ms** | ~5 MB (PNG Buffer) | 100% Deterministic |
| **Pass 2: Florence-2 Vision (OD + OCR)** | WebGPU via Transformers.js | **3.18 seconds** | ~320 MB System RAM / ~780 MB VRAM | Statistical ML |
| **Pass 2b: Overlap NMS & Box Union** | Handcoded Array Math | **< 2 ms** | < 100 KB | 100% Deterministic |
| **Pass 3: Canvas Redaction (Blur & Blackbox)** | HTML5 Canvas 2D API | **~12 ms** | ~8 MB | 100% Deterministic |
| **Pass 4: Server Action Reasoning** | Local Ollama (`gemma3:4b`) | **~1.2 seconds** | Server-side VRAM | Constrained JSON |

---

## 3. PII Detection Recall Across Data Modalities

Evaluated using standard Indian identification documents, enterprise application forms, and profile images:

| Data Type | Detection Source | Target Redaction Mode | Recall Rate | Precision Rate | Notes |
| :--- | :--- | :--- | :---: | :---: | :--- |
| **Password Fields** | DOM Scanner | `semantic_mock` (fixed `••••••••`) | **100%** | **100%** | Identified via `input[type="password"]` |
| **Form Fields** | DOM Scanner | `semantic_mock` (format-preserving fake) | **100%** | **100%** | Attribute & placeholder regex matching |
| **Human Faces / Photos** | Florence-2 `<OD>` | `gaussian_blur` | **97.2%** | **98%** | Outer head + facial features merged into single blur |
| **Rendered Email Text** | Florence-2 `<OCR>` | `black_box` | **94.5%** | **100%** | Regex-validated text quadrilateral matching |
| **Rendered Numbers (Aadhaar/PAN)** | Florence-2 `<OCR>` | `black_box` | **94.5%** | **100%** | Character-spacing resilient pattern matching |

---

## 4. Key Takeaways for SIH Evaluation Metric #4 (Resource Usage)

1. **Zero Memory Leaks:** Model weights are loaded once into browser CacheStorage / IndexedDB and memory is reused across inference cycles without bloating tab heap.
2. **Off-Thread Processing:** All vision inference occurs inside an isolated Web Worker (`offscreen.html`), keeping the user's active browsing experience smooth at 60 FPS without tab freezing.
3. **Graceful Fallback:** If WebGPU hardware acceleration is unavailable or disabled, the engine dynamically falls back to 4-bit WebAssembly (WASM CPU mode).
