#!/usr/bin/env node
// Counts the lines a player needed to integrate FireSense: the non-blank, non-comment lines
// between `// firesense:begin` and `// firesense:end` in the given file.
//   node scripts/count-integration-lines.mjs examples/plain-video-player/main.ts
import { readFileSync } from "node:fs";

export function countIntegrationLines(source) {
  let inside = false;
  let n = 0;
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (line === "// firesense:begin") inside = true;
    else if (line === "// firesense:end") inside = false;
    else if (inside && line !== "" && !line.startsWith("//")) n++;
  }
  if (inside) throw new Error("unterminated // firesense:begin");
  return n;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const file = process.argv[2] ?? "examples/plain-video-player/main.ts";
  console.log(`${countIntegrationLines(readFileSync(file, "utf8"))} lines of FireSense integration in ${file}`);
}
