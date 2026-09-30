// Copies ONNX Runtime's WebGPU/WASM runtime next to the worker bundle.
// worker.js loads it from the bundle's own directory because a browser extension's CSP
// (script-src 'self') blocks the default jsdelivr CDN / blob: URL loading.
// Usage: node copy-ort-runtime.mjs <output-dir>
import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

const outDir = process.argv[2] ?? '.';
const ortDist = new URL('./node_modules/onnxruntime-web/dist/', import.meta.url);

for (const file of ['ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm']) {
    copyFileSync(new URL(file, ortDist), join(outDir, file));
    console.log(`Copied ${file} -> ${outDir}`);
}
