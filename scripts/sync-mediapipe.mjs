#!/usr/bin/env node
// Copies the MediaPipe Tasks Vision WASM runtime from node_modules into public/mediapipe/wasm
// so the camera page never loads code from a third-party CDN. The WASM version always
// matches the installed @mediapipe/tasks-vision JS package.
// Models (public/mediapipe/models) are committed to the repository.
import { copyFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "node_modules/@mediapipe/tasks-vision/wasm");
const dest = join(root, "public/mediapipe/wasm");
const models = join(root, "public/mediapipe/models");

if (!existsSync(src)) {
  throw new Error(`MediaPipe WASM not found at ${src}. Run npm install first.`);
}
for (const model of ["pose_landmarker_full.task"]) {
  if (!existsSync(join(models, model))) {
    throw new Error(`Missing MediaPipe model public/mediapipe/models/${model}`);
  }
}

mkdirSync(dest, { recursive: true });
const files = readdirSync(src).filter((f) => /^vision_wasm_(nosimd_)?internal\.(js|wasm)$/.test(f));
if (files.length !== 4) {
  throw new Error(`Unexpected MediaPipe WASM layout in ${src}: ${files.join(", ")}`);
}
for (const f of files) copyFileSync(join(src, f), join(dest, f));
console.log(`[sync-mediapipe] copied ${files.length} files to public/mediapipe/wasm`);
