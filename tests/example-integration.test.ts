import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { countIntegrationLines } from "../scripts/count-integration-lines.mjs";

// The README states how many lines the second player needed. Keep that number honest.
describe("examples/plain-video-player", () => {
  const n = countIntegrationLines(readFileSync("examples/plain-video-player/main.ts", "utf8"));

  test("README states the counted integration size", () => {
    expect(readFileSync("README.md", "utf8")).toContain(`Its FireSense integration is **${n} lines**`);
  });

  test("the counter ignores blanks and comments, and needs closed markers", () => {
    expect(countIntegrationLines("a\n// firesense:begin\nx\n\n// note\ny\n// firesense:end\nz")).toBe(2);
    expect(() => countIntegrationLines("// firesense:begin\nx")).toThrow();
  });
});
