import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// docs/snippets/minimal-player.ts is type-checked against the real FireSenseViewer API.
// Keep docs/PROTOCOL.md quoting exactly that code so the doc cannot drift from the API.
describe("docs/PROTOCOL.md minimal integration", () => {
  const source = readFileSync("docs/snippets/minimal-player.ts", "utf8");
  const snippet = source.split("// --- snippet ---\n")[1].trim();
  const doc = readFileSync("docs/PROTOCOL.md", "utf8");

  test("the doc quotes the type-checked snippet verbatim", () => {
    expect(doc).toContain("```ts\n" + snippet + "\n```");
  });

  test("the snippet fits in 15 lines", () => {
    expect(snippet.split("\n").filter((l) => l.trim() !== "").length).toBeLessThanOrEqual(15);
  });
});
