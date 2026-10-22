/**
 * Plain Video Player — FireSense integrated into a page with no framework.
 *
 * Everything FireSense-specific is between the `firesense:begin` / `firesense:end` markers;
 * the rest is the player's own UI (ui.ts). `node scripts/count-integration-lines.mjs` counts
 * the marked lines, and tests/example-integration.test.ts keeps the README's number honest.
 */
import * as ui from "./ui";
// firesense:begin
import { FireSenseViewer, formatViewerError } from "@/lib/firesense/viewer";
// firesense:end

// Injected by scripts/build-example.mjs from the same NEXT_PUBLIC_* values as the Next.js build.
declare const __FIRESENSE_WS_URL__: string;
declare const __FIRESENSE_WEB_ORIGIN__: string;
const CREDS_KEY = "plain-player.firesense";

// firesense:begin
const viewer = new FireSenseViewer({
  url: __FIRESENSE_WS_URL__,
  credentials: {
    load: () => JSON.parse(localStorage.getItem(CREDS_KEY) ?? "null"),
    save: (c) => localStorage.setItem(CREDS_KEY, JSON.stringify(c)),
  },
  pairingUrl: (s, t) => `${__FIRESENSE_WEB_ORIGIN__}/camera/?${new URLSearchParams({ s, t })}`,
});
viewer.on("frame", (f) => {
  ui.video.style.filter = f.blurPx > 0 ? `blur(${f.blurPx}px)` : "none";
  ui.showLink(f.link.connected ? "connected" : f.link.reason === "SOCKET_CLOSED" ? "connecting" : "offline");
  ui.showModeChips(f.mode === "shadow", f.link.connected && f.test);
});
viewer.on("event", (e) => e.mode === "intervene" && e.type === "STAR_AWARDED" && ui.awardStar());
viewer.on("pairing", (p) => (ui.setPairingUrl(p.pairingUrl), p.cameraPaired || ui.showPairing(true)));
viewer.on("paired", () => ui.showPairing(false));
viewer.on("error", (e) => ui.showError(formatViewerError(e)));
ui.onPairingRequest(() => viewer.refreshPairing());
ui.onPairingVisible((open) => viewer.setPairingVisible(open));
ui.video.addEventListener("play", () => viewer.setPlaying(true));
ui.video.addEventListener("pause", () => viewer.setPlaying(false));
viewer.setPlaying(!ui.video.paused);
viewer.start();
// firesense:end
