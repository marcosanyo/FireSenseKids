#!/usr/bin/env node
// Builds examples/plain-video-player (no framework) into public/examples/plain-video-player/, so
// `next dev` serves it and the static export (→ S3 + CloudFront) ships it next to /tv and /camera.
// Same endpoints as the Next.js build; missing or non-TLS values fail the build (no defaults).
import { copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "examples/plain-video-player");
const out = join(root, "public/examples/plain-video-player");

const ws = process.env.NEXT_PUBLIC_WS_URL;
const web = process.env.NEXT_PUBLIC_WEB_ORIGIN;
if (!ws?.startsWith("wss://")) throw new Error(`[build-example] NEXT_PUBLIC_WS_URL must start with wss:// (got ${ws})`);
if (!web?.startsWith("https://")) throw new Error(`[build-example] NEXT_PUBLIC_WEB_ORIGIN must start with https:// (got ${web})`);

mkdirSync(out, { recursive: true });
const result = await build({
  entryPoints: [join(src, "main.ts")],
  outfile: join(out, "main.js"),
  bundle: true,
  minify: true,
  format: "iife",
  target: ["chrome61", "safari14"], // same floor as the app (package.json browserslist)
  tsconfig: join(root, "tsconfig.json"), // resolves "@/lib/…"
  define: {
    __FIRESENSE_WS_URL__: JSON.stringify(ws),
    __FIRESENSE_WEB_ORIGIN__: JSON.stringify(web.replace(/\/$/, "")),
  },
  metafile: true,
  logLevel: "warning",
});
for (const f of ["index.html", "style.css"]) copyFileSync(join(src, f), join(out, f));
const bytes = Object.values(result.metafile.outputs).reduce((a, o) => a + o.bytes, 0);
console.log(`[build-example] public/examples/plain-video-player/ (main.js ${(bytes / 1024).toFixed(0)} KB)`);
