/**
 * Amazon WebView (real Fire TV) video overlay workaround.
 *
 * On a real Fire TV, Amazon WebView plays every <video> into a hardware overlay (a SurfaceView behind
 * the page) instead of drawing it into the page. The page stays opaque over it, so the TV shows a
 * black screen while the audio plays, and CSS blur could not touch the picture anyway. Only one such
 * overlay exists per page (logcat: "AWV Unable to create overlay; MAX_OVERLAYS limit hit."); any
 * further video is drawn into the page like in a normal browser.
 *
 * So the APK first plays a hidden, muted 2px "holder" video to take that one overlay, and only then
 * gives the cartoon its src. The holder keeps playing a tiny all-black clip on a loop: the overlay is
 * a full-screen hardware plane under the page, and while the holder sat paused on one frame the real
 * TV flashed green on part of the screen (a stale buffer on that plane; screenshots and screen
 * recordings, which are composited on the GPU, never showed it). Releasing the holder is no fix:
 * Amazon WebView then moves the playing video into the overlay and the picture goes black again.
 * The clip must be at least 640×360: a 128×72 clip is not given the overlay (measured on the device). The emulator's WebView has no overlay; there the holder is harmless.
 * `watchVideoDrawn` keeps checking that the video really is drawn into the page (an overlay video
 * reads back as all-zero pixels), so a regression shows as an error instead of a silent black TV.
 */

const HOLDER_TIMEOUT_MS = 5000;
const DRAWN_TIMEOUT_MS = 8000;

let holder: Promise<void> | null = null;
let holderEl: HTMLVideoElement | null = null;
let holderSrc: string | null = null;

const once = (v: HTMLVideoElement, ev: string, timeoutMs: number, what: string) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what}: no "${ev}" within ${timeoutMs}ms`)), timeoutMs);
    v.addEventListener(ev, () => (clearTimeout(timer), resolve()), { once: true });
    v.addEventListener("error", () => (clearTimeout(timer), reject(new Error(`${what}: media error ${v.error?.code ?? "?"} ${v.error?.message ?? ""}`))), { once: true });
  });

/** Plays a hidden muted video (looping) so it owns the page's single overlay. Rejects on failure. */
export function claimVideoOverlay(src: string): Promise<void> {
  holderSrc = src;
  holder ??= new Promise<void>((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = "auto";
    v.setAttribute("aria-hidden", "true");
    Object.assign(v.style, {
      position: "fixed",
      left: "0",
      top: "0",
      width: "2px",
      height: "2px",
      opacity: "0",
      pointerEvents: "none",
    });
    const timer = setTimeout(() => fail(new Error(`overlay holder did not start within ${HOLDER_TIMEOUT_MS}ms`)), HOLDER_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      holderEl = v; // keeps looping (see above)
      resolve();
    };
    const fail = (err: Error) => {
      clearTimeout(timer);
      holder = null;
      v.remove();
      reject(err);
    };
    // A decoded frame (currentTime moves) means the player and its overlay exist.
    v.addEventListener("timeupdate", () => v.currentTime > 0 && done());
    v.addEventListener("error", () => fail(new Error(`overlay holder: media error ${v.error?.code ?? "?"}`)), { once: true });
    v.src = src;
    document.body.appendChild(v);
    v.play().catch((err: Error) => fail(new Error(`overlay holder: ${err.name}: ${err.message}`)));
  });
  return holder;
}

/** Restarts the holder from scratch (new player) and waits for its first frame. */
async function restartHolder(): Promise<void> {
  const v = holderEl;
  if (!v || !holderSrc) throw new Error("overlay holder was never started");
  v.pause();
  v.removeAttribute("src");
  v.load();
  v.src = holderSrc;
  const playing = once(v, "timeupdate", HOLDER_TIMEOUT_MS, "overlay holder");
  await v.play();
  await playing;
}

/** Does the current frame of `video` read back with a non-black pixel? (false = in the hardware overlay) */
function drawnNow(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): boolean {
  ctx.drawImage(video, 0, 0, 32, 18);
  const px = ctx.getImageData(0, 0, 32, 18).data;
  for (let i = 0; i < px.length; i += 4) if (px[i] || px[i + 1] || px[i + 2]) return true;
  return false;
}

/** Waits up to `waitMs` of playback for a drawn frame. */
async function drawnWithin(video: HTMLVideoElement, ctx: CanvasRenderingContext2D, waitMs: number): Promise<boolean> {
  for (let t = 0; t < waitMs; t += 250) {
    await new Promise((r) => setTimeout(r, 250));
    if (!video.paused && video.readyState >= 2 && drawnNow(video, ctx)) return true;
  }
  return false;
}

/** Hands the overlay back to the holder and reloads `video` at the same position. */
async function recover(video: HTMLVideoElement, ctx: CanvasRenderingContext2D): Promise<void> {
  const src = video.getAttribute("src");
  if (!src) return;
  const at = video.currentTime;
  video.pause();
  video.removeAttribute("src");
  video.load();
  await restartHolder();
  video.setAttribute("src", src);
  const loaded = once(video, "loadedmetadata", 15_000, "video");
  video.load();
  await loaded;
  video.currentTime = at;
  await video.play();
  if (!(await drawnWithin(video, ctx, DRAWN_TIMEOUT_MS))) {
    throw new Error(`video is not drawn into the page after ${DRAWN_TIMEOUT_MS / 1000}s of playback, even after giving the overlay back (hardware overlay)`);
  }
}

/**
 * Consecutive all-black reads (1 s apart) before the overlay is taken back. An overlay video reads as
 * exact zeros every time; a dark scene or a fade rarely stays exactly black this long.
 */
const MISSES_BEFORE_RECOVERY = 6;
/** Recoveries that may fail in a row before the error is shown (each is retried after the next misses). */
const FAILED_RECOVERIES_BEFORE_ERROR = 3;

/** One line per overlay event, to logcat through the APK's console bridge (`adb logcat -s FireSenseKids | grep firesense-overlay`). */
function log(event: string, video: HTMLVideoElement, extra: Record<string, unknown> = {}) {
  console.info(
    `[firesense-overlay] ${JSON.stringify({ event, at: new Date().toISOString(), src: (video.getAttribute("src") ?? "").split("/").pop(), t: Number(video.currentTime.toFixed(1)), ...extra })}`
  );
}

/**
 * Watches, while the TV plays, that `video` stays drawn into the page (so the picture is visible, the
 * blur applies, and the display chip does not composite it as a hardware video plane — which on the
 * real TV showed green stripes). The overlay can move to the video whenever players restart; then the
 * holder takes it back and the video reloads at the same position. `onError` gets the raw reason when
 * several recoveries in a row did not help; `onRecovered` when the picture is back.
 */
export function watchVideoDrawn(video: HTMLVideoElement, onError: (message: string) => void, onRecovered: () => void = () => undefined): () => void {
  const canvas = document.createElement("canvas");
  canvas.width = 32;
  canvas.height = 18;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    onError("canvas 2d context unavailable");
    return () => undefined;
  }
  let misses = 0;
  let failed = 0;
  let busy = false;
  let wasDrawn: boolean | null = null;
  const id = setInterval(() => {
    if (busy || video.paused || video.readyState < 2 || !video.getAttribute("src") || document.visibilityState !== "visible") return;
    const drawn = drawnNow(video, ctx);
    if (drawn !== wasDrawn) log(drawn ? "drawn" : "not_drawn", video);
    wasDrawn = drawn;
    if (drawn) {
      misses = 0;
      if (failed) {
        failed = 0;
        onRecovered();
      }
      return;
    }
    if (++misses < MISSES_BEFORE_RECOVERY) return;
    misses = 0;
    busy = true;
    log("recover_start", video, { failedSoFar: failed });
    recover(video, ctx)
      .then(() => {
        log("recover_ok", video);
        failed = 0;
        wasDrawn = true;
        onRecovered();
      })
      .catch((err: Error) => {
        failed++;
        log("recover_failed", video, { failed, message: err.message });
        if (failed >= FAILED_RECOVERIES_BEFORE_ERROR) onError(`${err.message} (${failed} recoveries in a row)`);
      })
      .finally(() => {
        busy = false;
      });
  }, 1000);
  return () => clearInterval(id);
}
