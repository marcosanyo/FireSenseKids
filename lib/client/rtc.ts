/**
 * WebRTC for the parent's live preview (camera phone → parent phone).
 *
 * No ICE servers at all (no STUN, no TURN): the only candidates are the phones' own
 * addresses, so the video can only flow inside the home network and never through a
 * server. If the two phones cannot reach each other directly, the preview fails and
 * says so; there is no relayed path to fall back to.
 */

import { L } from "../firesense/i18n";


export const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

/** Waits until all local candidates are in the SDP (host candidates only: usually a few ms). */
export function iceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 3000): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", check);
      reject(new Error(L(`Could not gather WebRTC candidates within ${timeoutMs / 1000} s (iceGatheringState=${pc.iceGatheringState})`, `WebRTC の接続候補を ${timeoutMs / 1000} 秒以内に集められませんでした（iceGatheringState=${pc.iceGatheringState}）`)));
    }, timeoutMs);
    const check = () => {
      if (pc.iceGatheringState !== "complete") return;
      clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    pc.addEventListener("icegatheringstatechange", check);
  });
}

/** Explains a preview that did not connect. The usual causes are network, not the app. */
export function previewNetworkHint(): string {
  return L(
    "The video goes directly between the two phones inside your home Wi-Fi (never through the cloud). Check that both are on the same Wi-Fi, and that it is not a guest network or set to block devices from talking to each other (AP isolation).",
    "映像は家の Wi-Fi の中でスマホ同士を直接つないで送ります（クラウドは通りません）。2台が同じ Wi-Fi につながっているか、ゲスト Wi-Fi や「端末どうしの通信を遮断（AP アイソレーション）」の設定になっていないかを確認してください。"
  );
}
