/**
 * The player's own UI (no FireSense in here): link badge, stars, QR panel, error toast.
 * A real player already has its equivalents; FireSense only calls into them (see main.ts).
 */
import QRCode from "qrcode";

const $ = <T extends HTMLElement>(id: string) => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is missing from index.html`);
  return el as T;
};

export const video = $<HTMLVideoElement>("video");
const linkChip = $<HTMLButtonElement>("chip-link");
const linkText = $("link-text");
const shadowChip = $("chip-shadow");
const testChip = $("chip-test");
const starChip = $("chip-stars");
const starCount = $("stars");
const burst = $("burst");
const pair = $("pair");
const qr = $("qr");
const pairLink = $<HTMLAnchorElement>("pair-link");
const toast = $("toast");

// Your own video: ?src=https://… (must allow cross-origin playback).
const src = new URLSearchParams(location.search).get("src");
if (src) video.src = src;

export type LinkView = "connecting" | "connected" | "offline";

/** Sensor badge. Offline is calm, persistent, and says the picture stays clear. */
export function showLink(view: LinkView): void {
  linkChip.dataset.state = view;
  linkText.textContent =
    view === "connected" ? "Sensor connected" : view === "offline" ? "Sensor not connected · video stays clear" : "Connecting to relay…";
}

export function showModeChips(shadow: boolean, test: boolean): void {
  shadowChip.hidden = !shadow;
  testChip.hidden = !test;
  starChip.hidden = shadow; // record-only mode awards nothing
}

const DAY_KEY = "plain-player.stars";
const today = () => new Date().toDateString();
let stars = (() => {
  try {
    const saved = JSON.parse(localStorage.getItem(DAY_KEY) ?? "null") as { day: string; n: number } | null;
    return saved?.day === today() ? saved.n : 0;
  } catch {
    return 0;
  }
})();
starCount.textContent = String(stars);

export function awardStar(): void {
  stars += 1;
  starCount.textContent = String(stars);
  localStorage.setItem(DAY_KEY, JSON.stringify({ day: today(), n: stars }));
  for (const [el, cls] of [
    [starChip, "pop"],
    [burst, "go"],
  ] as const) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation
    el.classList.add(cls);
  }
}

// ---- QR panel -----------------------------------------------------------------
let pairingUrl: string | null = null;
let onVisible: (visible: boolean) => void = () => {};

export function onPairingVisible(cb: (visible: boolean) => void): void {
  onVisible = cb;
}

export function setPairingUrl(url: string): void {
  if (url === pairingUrl) return;
  pairingUrl = url;
  pairLink.href = url;
  QRCode.toDataURL(url, { width: 480, margin: 1, errorCorrectionLevel: "M" })
    .then((data) => {
      qr.innerHTML = "";
      const img = new Image();
      img.src = data;
      img.alt = "Pairing QR code";
      qr.append(img);
    })
    .catch((err: Error) => showError(`Cannot draw the QR code: ${err.message}`));
}

export function showPairing(open: boolean): void {
  if (pair.hidden === !open) return;
  pair.hidden = !open;
  onVisible(open);
  if (open) $("pair-close").focus();
}

let onRequest: () => void = () => {};
export function onPairingRequest(cb: () => void): void {
  onRequest = cb;
}

linkChip.addEventListener("click", () => {
  onRequest();
  showPairing(true);
});
$("pair-close").addEventListener("click", () => showPairing(false));
window.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && pair.hidden && document.activeElement === document.body) {
    onRequest();
    showPairing(true);
  } else if (e.key === "Escape") showPairing(false);
});

// ---- errors (shown as-is, never swallowed) -----------------------------------------
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function showError(message: string): void {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.hidden = true), 12_000);
}
