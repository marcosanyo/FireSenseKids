#!/usr/bin/env node
// Copies the ONNX Runtime Web runtime (the WebGPU build) from node_modules into public/ort so the
// watch camera's RTMO estimator never loads code from a third-party CDN. The version always matches the
// installed onnxruntime-web JS package. The RTMO models themselves are uploaded to S3 models/
// (scripts/upload-models.sh).
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/onnxruntime-web/dist");
const dest = join(root, "public/ort");
// The WebGPU build of 1.30 loads the "asyncify" variant (it also runs the WASM backend).
const files = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];
for (const f of files) {
  if (!existsSync(join(src, f))) throw new Error(`ONNX Runtime Web file not found: ${join(src, f)}. Run npm install first.`);
}
mkdirSync(dest, { recursive: true });
for (const f of files) copyFileSync(join(src, f), join(dest, f));
console.log(`[sync-ort] copied ${files.length} files to public/ort`);
