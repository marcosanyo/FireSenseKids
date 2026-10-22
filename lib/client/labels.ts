/** Words shown to parents for the phone's raw states (the protocol keeps the English codes). */

import { L } from "../firesense/i18n";
import type { PostureType, ViewingState } from "../firesense/protocol";

type Tone = "ok" | "warn" | "bad" | "none";

// Getters: the language is set after this module loads.
export const STATE_LABEL: Record<ViewingState, { readonly text: string; tone: Tone }> = {
  SAFE: { get text() { return L("Good distance", "ちょうどよい距離"); }, tone: "ok" },
  APPROACHING: { get text() { return L("Getting closer", "近づいています"); }, tone: "warn" },
  TOO_CLOSE: { get text() { return L("Too close", "近すぎ"); }, tone: "bad" },
  BELOW_FRAME: { get text() { return L("Too close (feet below the view)", "近すぎ（足元が画面の外）"); }, tone: "bad" },
  LOW_CONFIDENCE: { get text() { return L("Nobody in view", "人が見えていません"); }, tone: "none" },
};

export const POSTURE_LABEL: Record<PostureType, string> = {
  get GOOD() { return L("Good posture", "よい姿勢"); },
  get SLOUCH() { return L("Slouching", "猫背ぎみ"); },
  get LYING_DOWN() { return L("Lying down", "寝そべり"); },
  UNKNOWN: "—",
};

export const LINK_LABEL: Record<string, string> = {
  get open() { return L("Connected", "接続中"); },
  get connecting() { return L("Connecting", "接続しています"); },
  get closed() { return L("Disconnected", "切断"); },
  get idle() { return L("Idle", "待機中"); },
};
