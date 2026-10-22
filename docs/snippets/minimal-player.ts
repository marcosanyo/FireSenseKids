/**
 * The minimal FireSense integration quoted in docs/PROTOCOL.md.
 * `npm run typecheck` compiles it against the real API, and tests/protocol-doc.test.ts
 * checks that the doc quotes everything below the marker verbatim (and in ≤ 15 lines).
 */
declare const RELAY_URL: string; // wss://… (terraform output websocket_url)
declare const CAMERA_PAGE: string; // https://…/camera/ (the phone page, served over HTTPS)
declare const offlineBadge: HTMLElement; // your "sensor not connected" badge
declare function showStar(): void; // your reward
declare function showQr(url: string): void; // your QR screen

// --- snippet ---
import { FireSenseViewer } from "@/lib/firesense";

const video = document.querySelector("video")!;
const viewer = new FireSenseViewer({
  url: RELAY_URL,
  credentials: {
    load: () => JSON.parse(localStorage.getItem("firesense") ?? "null"),
    save: (c) => localStorage.setItem("firesense", JSON.stringify(c)),
  },
  pairingUrl: (s, t) => `${CAMERA_PAGE}?s=${s}&t=${t}`,
});
viewer.on("frame", (f) => { video.style.filter = `blur(${f.blurPx}px)`; offlineBadge.hidden = f.link.connected; });
viewer.on("event", (e) => e.mode === "intervene" && e.type === "STAR_AWARDED" && showStar());
viewer.on("pairing", (p) => p.cameraPaired || showQr(p.pairingUrl));
video.onplay = video.onpause = () => viewer.setPlaying(!video.paused);
viewer.start();
