import { describe, expect, test } from "vitest";
import { computeTvVisualStyles } from "../lib/client/tv-visuals";

describe("TV Visual Filter Mapping (U2 §3)", () => {
  test("blurPx = 0 returns 'none' and unmodified brightness/saturate", () => {
    const full = computeTvVisualStyles(0, "full");
    expect(full.filter).toBe("none");
    expect(full.transform).toBe("none");
    expect(full.brightness).toBe(1);
    expect(full.saturate).toBe(1);
    expect(full.effectiveBlurPx).toBe(0);

    const downscale = computeTvVisualStyles(0, "downscale");
    expect(downscale.filter).toBe("none");
    expect(downscale.transform).toBe("scale(8)");
    expect(downscale.brightness).toBe(1);
    expect(downscale.saturate).toBe(1);
  });

  test("negative blurPx is treated as 0", () => {
    const res = computeTvVisualStyles(-5, "full");
    expect(res.filter).toBe("none");
    expect(res.brightness).toBe(1);
  });

  test("blurPx = 12 (midway) scales blur by 2 and dims/desaturates to 0.8", () => {
    const full = computeTvVisualStyles(12, "full");
    expect(full.filter).toBe("blur(24px) brightness(0.8) saturate(0.8)");
    expect(full.transform).toBe("scale(1.05)");
    expect(full.effectiveBlurPx).toBe(24);
    expect(full.brightness).toBe(0.8);
    expect(full.saturate).toBe(0.8);

    const downscale = computeTvVisualStyles(12, "downscale");
    expect(downscale.filter).toBe("blur(3px) brightness(0.8) saturate(0.8)");
    expect(downscale.transform).toBe("scale(8)");
    expect(downscale.effectiveBlurPx).toBe(3);
  });

  test("blurPx = 24 (maximum) scales blur to 48px and dims/desaturates to 0.6", () => {
    const full = computeTvVisualStyles(24, "full");
    expect(full.filter).toBe("blur(48px) brightness(0.6) saturate(0.6)");
    expect(full.transform).toBe("scale(1.05)");
    expect(full.effectiveBlurPx).toBe(48);
    expect(full.brightness).toBe(0.6);
    expect(full.saturate).toBe(0.6);

    const downscale = computeTvVisualStyles(24, "downscale");
    expect(downscale.filter).toBe("blur(6px) brightness(0.6) saturate(0.6)");
    expect(downscale.transform).toBe("scale(8)");
    expect(downscale.effectiveBlurPx).toBe(6);
    expect(downscale.brightness).toBe(0.6);
    expect(downscale.saturate).toBe(0.6);
  });

  test("blurPx > 24 clamps ratio at 1.0", () => {
    const res = computeTvVisualStyles(30, "full");
    expect(res.brightness).toBe(0.6);
    expect(res.saturate).toBe(0.6);
  });
});
