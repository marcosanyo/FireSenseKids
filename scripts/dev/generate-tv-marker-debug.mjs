#!/usr/bin/env node
// DEV ONLY: debug images for TV-marker calibration on /camera.
// The phone sits on a shelf at the side of the room and sees both the TV screen (diagonally)
// and the floor in front of it. Base = screen black; edits of the same image: screen magenta,
// and a person standing at two distances. Uses an image-generation model with GEMINI_API_KEY.
// Note: the model renders the viewpoint higher than asked (~1.25 m, inferred from the screen
// bottom height); /camera uses that value for this scene.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const key = process.env.GEMINI_API_KEY;
if (!key) throw new Error("GEMINI_API_KEY is required");
const model = process.env.IMAGE_MODEL ?? "gemini-3.1-flash-image";
const out = join(dirname(fileURLToPath(import.meta.url)), "../../public/debug");
mkdirSync(out, { recursive: true });

async function generate(parts) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({ contents: [{ parts }], generationConfig: { responseModalities: ["IMAGE"] } }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status} ${JSON.stringify(body).slice(0, 400)}`);
  const part = body.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
  if (!part) throw new Error(`no image in response ${JSON.stringify(body).slice(0, 400)}`);
  return Buffer.from(part.inlineData.data, "base64");
}

const basePath = join(out, "tv-black.jpg");
if (!existsSync(basePath) || process.env.REGENERATE_BASE === "1") {
  writeFileSync(
    basePath,
    await generate([
      {
        text:
          "Photorealistic photo, 4:3 landscape, taken by a phone camera resting on a shelf about 80 cm above the floor at the RIGHT side of a " +
          "Japanese living room, about 1.8 m to the right of the TV and 1.4 m in front of it, looking diagonally back toward the TV. " +
          "A 55-inch flat TV on a low TV stand is in the LEFT-CENTER of the frame, seen at an angle of about 45 degrees, and its WHOLE screen " +
          "is clearly visible with all four corners inside the image, not cut off. The screen is switched off and completely black, no reflections. " +
          "The lower half of the image shows the empty wooden floor in front of the TV (where a child would stand), from near the TV stand to " +
          "about 2.5 m in front of it. Bright, tidy room, sofa at the far right. No people, no text, no watermark, no phone or shelf visible.",
      },
    ])
  );
  console.log("[debug] tv-black.jpg");
}
const base = { inlineData: { mimeType: "image/jpeg", data: readFileSync(basePath).toString("base64") } };
const KEEP = "Keep the camera angle, framing, room, furniture, lighting and everything else exactly the same, pixel for pixel where possible.";
const EDITS = {
  "tv-magenta":
    "Edit this photo: the TV screen now shows a single flat, uniform, fully saturated bright MAGENTA color (#FF00FF) filling the entire " +
    "screen area edge to edge, like a solid test color. No image, no text, no gradient, no glare on the screen. " + KEEP,
  "tv-person-near":
    "Edit this photo: add one adult standing upright on the floor about 1 meter in front of the TV screen, roughly in front of the TV's center, " +
    "facing the TV (side/back view), whole body and both feet visible on the floor. The TV screen stays black. " + KEEP,
  "tv-person-far":
    "Edit this photo: add one adult standing upright on the floor about 2 meters in front of the TV screen, roughly in front of the TV's center, " +
    "facing the TV (side/back view), whole body and both feet visible on the floor. The TV screen stays black. " + KEEP,
};
// Posture debug (same room; far enough from the TV to be SAFE, so the posture nudge can fire).
Object.assign(EDITS, {
  "tv-sit-slouch":
    "Edit this photo: add one adult sitting on the floor about 2.2 meters in front of the TV screen, roughly in front of the TV's center, " +
    "watching the TV with a clearly BAD posture: back strongly rounded (hunched), shoulders slumped forward, head and neck pushed far forward " +
    "toward the TV. Seen from the side-back. The TV screen stays black. " + KEEP,
  "tv-sit-upright":
    "Edit this photo: add one adult sitting on the floor about 2.2 meters in front of the TV screen, roughly in front of the TV's center, " +
    "watching the TV with a clearly GOOD posture: back straight and upright, shoulders back, head directly above the shoulders. " +
    "Seen from the side-back. The TV screen stays black. " + KEEP,
  "tv-lying":
    "Edit this photo: add one adult lying on their stomach on the floor about 2.2 meters in front of the TV screen, propped on the elbows, " +
    "watching the TV, body stretched out on the floor. The TV screen stays black. " + KEEP,
});
const only = process.env.ONLY?.split(",");
for (const [name, text] of Object.entries(EDITS)) {
  if (only && !only.includes(name)) continue;
  writeFileSync(join(out, `${name}.jpg`), await generate([base, { text }]));
  console.log(`[debug] ${name}.jpg`);
}
