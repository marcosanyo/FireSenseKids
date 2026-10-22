#!/usr/bin/env node
// DEV ONLY: generates the fixed debug images used by /camera's "Debug image" source:
// one base room from the watch phone's viewpoint with two tape marks, then edits of the SAME
// image with an adult standing on the near mark (A), the far mark (B), and too close (feet cut off).
// Editing one base keeps the camera geometry identical across images, so 2-point calibration on
// A/B and the resulting distances are self-consistent. Output: public/debug/*.jpg.
// Uses an image-generation model with GEMINI_API_KEY; not part of the product (product AI = Claude on Bedrock).
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
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

const basePath = join(out, "room-empty.jpg");
if (!existsSync(basePath) || process.env.REGENERATE_BASE === "1") {
  writeFileSync(
    basePath,
    await generate([
      {
        text:
          "Photorealistic smartphone photo, 4:3 landscape, taken by a phone standing on a low TV stand about 55 cm above the floor, " +
          "tilted about 20 degrees downward, looking into a bright, tidy Japanese living room. The TV is not visible. " +
          "The bottom edge of the frame shows plain light wooden floor right in front of the stand (no furniture in the foreground). " +
          "On the floor, centered, there are two strips of bright blue masking tape across the view: a near strip in the lower third of the image " +
          "and a far strip around the vertical middle of the image. A sofa stands against the far wall well behind the far strip. " +
          "Open empty floor between the tapes. No people, no text, no watermark.",
      },
    ])
  );
  console.log("[debug] room-empty.jpg");
}
const base = { inlineData: { mimeType: "image/jpeg", data: readFileSync(basePath).toString("base64") } };

const EDITS = {
  "pose-a-near":
    "Edit this photo: add one adult (a parent in casual clothes) standing upright, facing the camera, with both feet on the NEAR blue tape strip. " +
    "The whole body including both feet and shoes must be clearly visible inside the frame. Keep the camera angle, room, lighting and tape exactly the same.",
  "pose-b-far":
    "Edit this photo: add one adult (a parent in casual clothes) standing upright, facing the camera, with both feet on the FAR blue tape strip. " +
    "The whole body including both feet must be visible. Keep the camera angle, room, lighting and tape exactly the same.",
  "pose-too-close":
    "Edit this photo: add one adult standing very close to the camera, about 60 cm away, facing the camera. Because they are so close, " +
    "their legs below the knees and their feet are cut off by the bottom edge of the frame, while shoulders, torso and hips are clearly visible. " +
    "Keep the camera angle, room and lighting exactly the same.",
};

for (const [name, text] of Object.entries(EDITS)) {
  writeFileSync(join(out, `${name}.jpg`), await generate([base, { text }]));
  console.log(`[debug] ${name}.jpg`);
}
