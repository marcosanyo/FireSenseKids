# FireSense Protocol — integrating FireSense into your player

For developers who want FireSense in **their own** video player. `/tv` in this repo is the reference player; everything it needs from FireSense lives in one class, `FireSenseViewer` ([`lib/firesense/viewer.ts`](../lib/firesense/viewer.ts)).

## In five lines

1. A phone next to the TV runs pose estimation **on the device** and decides everything: distance, state, how much to blur.
2. Only numbers reach the cloud (state, distance, `blurPx`, posture, confidence). No images, ever. (A parent phone may view the camera during setup, but only phone-to-phone on the home network; see "Parent phones".)
3. An AWS WebSocket relay forwards those numbers to the TV of the same session.
4. The TV only draws: it blurs its video by `blurPx` and, if the player offers child cues, shows its own when an event arrives.
5. If the phone disappears, the TV clears the blur and says the sensor is not connected.

## Minimal integration

```ts
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
```

The snippet above is [`docs/snippets/minimal-player.ts`](./snippets/minimal-player.ts). `npm run typecheck` compiles it against the real API, and `tests/protocol-doc.test.ts` fails if this page stops quoting it verbatim. `RELAY_URL` is the relay's `wss://` URL (`terraform output websocket_url`), `CAMERA_PAGE` is the HTTPS `/camera/` page (under `cloudfront_url`) the phone opens from the QR code. The engine appends `role=tv` to the relay URL itself.

## The player's promises

- **The TV does not decide.** The real-time intervention loop runs on the phone. Render `frame.blurPx` and `frame.state` as they come. Do not compute your own thresholds.
- **When the link is down, clear the blur and say so.** The engine already sends `blurPx: 0` and `state: null` while `frame.link.connected` is false. The player must still show that the sensor is not connected (the reference player shows a calm "Sensor not connected" badge). Clearing silently is not allowed.
- **In shadow mode, show nothing that reacts to distance — but keep recording.** The phone can run a field-pilot "record only" mode (`mode: "shadow"`). The engine already sends `blurPx: 0`; the player must also skip its cards, voice, sounds and stars (`event.mode === "shadow"`), and may show a small fixed "record only" label that never changes with distance.
- **Never record `test: true`.** Frames and events from the phone's test mode carry `test: true`. Show them (label them as test input), but never count them in statistics.
- **Report playback.** Call `viewer.setPlaying()` on play and pause. The phone runs its camera only while the TV is playing.
- **Surface errors.** `on("error")` delivers relay errors as-is (`formatViewerError(err)` gives `[code] message`). Show them; do not swallow them.

## `FireSenseViewer` API

| Member | What it does |
|---|---|
| `new FireSenseViewer({ url, credentials: { load, save }, pairingUrl, logger?, createTransport? })` | `load()`/`save(creds \| null)` persist `{ sessionId, tvSecret }` wherever you like (`save(null)` = forget). `createTransport` swaps the WebSocket for tests. |
| `start()` / `stop()` | Connect (with 1→2→4…30 s reconnect to the same endpoint) and run the 250 ms link check / tear down. |
| `on("frame", f)` | `{ blurPx, mode, state, distanceM, floor, posture, confidence, link: { connected, reason }, test, seq }` (`floor` = `{ lateralM, frontM }` of the measurement, TV-marker calibration only, else null). Sent on every accepted telemetry, whenever the link changes, and when the mode changes. `blurPx` is 0 while disconnected and in shadow mode. |
| `on("event", e)` | `{ type: "STAR_AWARDED" \| "PHASE1_RECOVERY" \| "WARN" \| "POSTURE_NUDGE", mode, test }`. Play your own sound, mascot, toast — only when `mode` is `"intervene"`. |
| `on("session", s)` | `{ sessionId, created }` on every (re)connect. |
| `on("pairing", p)` | `{ sessionId, token, expiresAt, cameraPaired, pairingUrl }`. Draw `pairingUrl` as a QR code. |
| `on("paired", …)` | A phone just completed QR pairing (not sent on reconnects). |
| `on("calibrationPattern", pattern)` | `"magenta" \| "black" \| "off"`. Fill the whole screen with that color, then call `ackCalibrationPattern(pattern)` once it is painted (the reference player waits two animation frames). |
| `on("error", err)` | `{ source: "server", code, message }` or `{ source: "transport", message }`. |
| `on("linkLost", l)` | `{ atMs, link, lastPeerMessageAgoMs, blurPxBefore, test }` when the link goes from up to down: why, how long before the drop was detected the phone was last heard, and the blur that was on screen. For measurements; the frame already carries `blurPx: 0`. |
| `measureRoundTrip(timeoutMs?)` | One `rtt_ping` → `rtt_pong` round trip TV → relay → phone → relay → TV, in ms on the TV's clock. Rejects on timeout (default 5 s), without a session, or with the socket closed. Camera capture and pose detection are not included. |
| `on("relay", r)` / `on("heartbeat", h)` | Socket state (`connecting` / `open` / `closed`) and the phone's inference fps, for "reconnecting…" UI and diagnostics. |
| `setPlaying(playing)` | Sends `viewing_state`. |
| `setPairingVisible(visible)` | While the QR is on screen, the engine refreshes the one-time token 10 s before it expires. |
| `refreshPairing()` / `resetPairing()` / `newSession()` | Fresh QR token / revoke the paired phone / forget credentials and start a new session. |
| `credentials`, `disconnects()`, `lastTelemetry` | Current `{ sessionId, tvSecret }` (for your own HTTP calls), disconnect count and seconds (for daily summaries), last raw telemetry (diagnostics only). |

### When is the link "down"?

Any one of these (implementation plan §3, `PeerLinkMonitor` in [`transport.ts`](../lib/firesense/transport.ts)):

1. the WebSocket closes (`reason: "SOCKET_CLOSED"`);
2. the phone says it is leaving with `camera_leaving` (`PEER_LEFT`, with `link.peerLeft`: `"hidden"` = the watch page went to the background, `"pagehide"` = it is being closed). The link drops at once instead of 3 s later, and the reason stays until fresh telemetry arrives;
3. the relay reports `peer_status { peer: "camera", connected: false }` (`PEER_OFFLINE`);
4. neither telemetry nor heartbeat has arrived for 3 s (`SILENT`). This is the only case where the TV does not know why; show it as unknown rather than guessing.

After a drop, the link comes back only with fresh telemetry (`WAITING_FIRST_TELEMETRY` until then). Out-of-order telemetry (`seq` not greater than the last one) is dropped; the sequence restarts after a drop, so a restarted phone is accepted.

## Messages

All messages are JSON with `v: 1`. The zod schemas in [`lib/firesense/protocol.ts`](../lib/firesense/protocol.ts) are the source of truth, shared by the phone, the TV, and the Lambda relay. The relay rejects anything that does not parse.

| Message | Direction | Meaning |
|---|---|---|
| `telemetry` (`TelemetrySchema`) | phone → TV | State, `distanceM`, `blurPx` (0–24), posture, confidence, optional `event`, `mode` (`intervene` / `shadow`, required), optional `floor` (`{ lateralM, frontM }`, 0.1 m steps, TV-marker calibration only: where the distance was measured, for the daily floor heatmap `modes.*.floorSeconds`), optional `test: true`, monotonic `seq`. `distanceM` is measured from the screen: with a TV-marker calibration straight ahead in front of it and to the nearest screen edge beside it (a zone with rounded ends), and, when the feet are hidden, estimated from the hips; other calibrations only know the distance from the screen plane. |
| `heartbeat` (`HeartbeatSchema`) | phone → TV | 1 Hz liveness with the current inference fps and `mode` (required). |
| `calibration_pattern` (`CalibrationPatternSchema`) | phone → TV | Paint the screen `magenta` / `black` / `off` (the TV is the ruler for calibration). |
| `calibration_pattern_ack` (`CalibrationPatternAckSchema`) | TV → phone | The pattern is on screen. |
| `viewing_state` (`ViewingStateMessageSchema`) | TV → phone | The video is playing / paused. |
| `camera_leaving` (`CameraLeavingSchema`) | phone → TV | The watch page is going away: `reason` `hidden` or `pagehide`. Best effort; the phone sends no telemetry while hidden. |
| `rtt_ping` (`RttPingSchema`) / `rtt_pong` (`RttPongSchema`) | TV → phone / phone → TV | Round-trip probe with an integer `id`; the phone answers at once. For measurements only. |
| `tv_hello` (`TvHelloSchema`) | TV → relay | Open a new session, or resume one with `sessionId` + `tvSecret`. Also requests a fresh pairing token. |
| `pairing_reset` (`PairingResetSchema`) | TV → relay | Revoke the paired phone and issue a new token. |
| `camera_hello` (`CameraHelloSchema`) | phone → relay | Join with the one-time QR token, or resume with `cameraSecret`. |
| `session` (`SessionIssuedSchema`) | relay → TV | Session id, one-time pairing token and expiry, whether a phone is paired; `tvSecret` only when newly created. |
| `peer_status` (`PeerStatusSchema`) | relay → both | The other device connected / disconnected. |
| `camera_paired` (`CameraPairedSchema`) | relay → TV | A phone completed QR pairing. |
| `paired` (`PairedSchema`) | relay → phone | Pairing accepted; the phone stores `cameraSecret`. |
| `unpaired` (`UnpairedSchema`) | relay → phone | The TV revoked this phone. |
| `error` (`ServerErrorSchema`) | relay → any | `code` (`BAD_MESSAGE`, `SESSION_NOT_FOUND`, `BAD_CREDENTIALS`, `TOKEN_EXPIRED`, `TOKEN_USED`, `NOT_PAIRED`, `PARENT_LIMIT`, `INTERNAL`) and a raw message. |
| `parent_pairing_request` (`ParentPairingRequestSchema`) | TV → relay | Ask for a one-time parent QR token; `reset: true` first revokes every parent phone. |
| `parent_pairing` (`ParentPairingSchema`) | relay → TV | Token, expiry, and how many parent phones are registered (max 4). |
| `parent_joined` (`ParentPairedNoticeSchema`) | relay → TV | A parent phone completed QR pairing. |
| `parent_hello` (`ParentHelloSchema`) | parent → relay | Join with the parent QR token, or resume with `parentSecret`. |
| `parent_paired` (`ParentPairedSchema`) | relay → parent | Pairing accepted; the phone stores `parentSecret`. |
| `tv_playlist` (`TvPlaylistSchema`) | parent → TV | The list to play from the start: `{ id, title, items: [{ title, url, credit? }] }`, 1–50 items, https URLs (or a video bundled in the TV app, `/videos/…`). The TV fetches the files itself; only the list crosses the relay. |
| `tv_control` (`TvControlSchema`) | parent → TV | `next` / `previous` / `restart` within the list. |
| `playlist_save` (`PlaylistSaveSchema`) | parent → relay | The family's own list (or `null` to clear), built one item at a time on a parent phone. Stored with the session in DynamoDB. |
| `playlist_library` (`PlaylistLibrarySchema`) | relay → parents | The saved list, on connect and after every save, so all parent phones edit the same list. |
| `tv_now_playing` (`TvNowPlayingSchema`) | TV → parents | Playlist, index / count, title and the raw error of the current item (on every change, and every 20 s). The relay keeps the last one and sends it to a parent phone when it connects. |
| `tv_settings_save` (`TvSettingsSaveMessageSchema`) | parent → relay | Save the TV intervention settings: `{ childCues: boolean, marker: boolean, pause: { enabled: boolean, afterSeconds: 10..60 } }`. Stored with the session in DynamoDB. |
| `tv_settings` (`TvSettingsMessageSchema`) | relay → TV & parents | Current TV intervention settings (sent on `tv_hello` / `parent_hello` and after every save). |
| `camera_status` (`CameraStatusSchema`) | phone → parents | About 1 Hz while a parent is connected: mode, thresholds, calibration summary, live numbers (incl. optional `distanceSource`: `feet` / `hips`), errors. |
| `camera_command` (`CameraCommandMessageSchema`) | parent → phone | `set_mode`, `set_settings`, `set_floor_bottom`, `set_blackout`, `calibrate_tv`, `calibrate_stand`, `calibrate_tap`, `preview_overlay`. |
| `camera_command_result` (`CameraCommandResultSchema`) | phone → parents | `ok` and the raw message for one command `id`. |
| `rtc_signal` (`RtcSignalSchema`) | parent ↔ phone | WebRTC `offer` / `answer` / `hangup` / `error` for the live preview (complete SDP, host candidates only). |

## Parent phones

The watch phone is meant to be installed once and left alone. A parent phone pairs from a second QR code on the TV (`FireSenseViewer.requestParentPairing()`, rendered from `on("parentPairing")`; the reference player shows it under OK → "Add a parent phone"). Up to four parent phones per session; the TV can revoke them all.

- The relay forwards `camera_status`, `camera_command(_result)` and `rtc_signal` between the watch phone and every connected parent phone, tells the watch phone whether any parent is connected (`peer_status { peer: "parent" }`), and never sends any of it to the TV.
- The watch phone is the source of truth: it applies each command, keeps the values on the phone, and answers with `ok` and the raw message. If it is offline, the parent sees that; commands are not queued.
- Live preview: WebRTC with **no ICE servers** on either side (`lib/client/rtc.ts`). Only host candidates exist, so the video can only flow inside the home network; the relay carries only the SDP (not logged). If the phones cannot reach each other directly (different networks, guest Wi-Fi, AP isolation), the preview fails with that explanation; there is no relayed fallback.
- The HTTP API (`/session/summary`, `/report/weekly`, `/session/reminder`) also accepts `Bearer <sessionId>:<parentSecret>`.

## Players that are not web pages

`FireSenseViewer` is plain TypeScript (only `WebSocket` and `window`). A native player (Kotlin, for example) can integrate FireSense by implementing the same message flow and the promises above against the schemas in `protocol.ts`.
