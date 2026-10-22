/**
 * Key-value persistence. Inside the Fire TV APK, values go to Android SharedPreferences
 * through the `FiresenseNative` JavaScript bridge; in a browser, to localStorage.
 */

interface FiresenseNativeBridge {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  exitApp(): void;
}

declare global {
  interface Window {
    FiresenseNative?: FiresenseNativeBridge;
  }
}

export function nativeBridge(): FiresenseNativeBridge | null {
  return typeof window !== "undefined" && window.FiresenseNative ? window.FiresenseNative : null;
}

export const storage = {
  get(key: string): string | null {
    if (typeof window === "undefined") return null;
    const n = nativeBridge();
    return n ? n.getItem(key) : window.localStorage.getItem(key);
  },
  set(key: string, value: string): void {
    if (typeof window === "undefined") return;
    const n = nativeBridge();
    if (n) n.setItem(key, value);
    else window.localStorage.setItem(key, value);
  },
  remove(key: string): void {
    if (typeof window === "undefined") return;
    const n = nativeBridge();
    if (n) n.removeItem(key);
    else window.localStorage.removeItem(key);
  },
  getJson<T>(key: string): T | null {
    const raw = this.get(key);
    return raw ? (JSON.parse(raw) as T) : null;
  },
  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  },
};

export const KEYS = {
  tvSession: "firesense.tv.session", // { sessionId, tvSecret }
  tvDaily: "firesense.tv.daily", // DailySummary for the current local date
  cameraSession: "firesense.camera.session", // { sessionId, cameraSecret }
  floorModel: "firesense.camera.floorModel", // FloorCalibrationModel
  cameraMode: "firesense.camera.mode", // "intervene" | "shadow" (field pilot, T2)
  parentSession: "firesense.parent.session", // { sessionId, parentSecret } (parent phone)
  tvPlaylist: "firesense.tv.playlist", // { playlist, index } (TV: what the parent picked, and where it was)
  tvSettings: "firesense.tv.settings", // TvSettings (childCues, marker, pause)
  tvPosition: "firesense.tv.position", // { url, t }: where the current video was, restored after a reload
  lang: "firesense.lang", // "en" | "ja": this device's UI language (lib/client/lang.ts)
  poseModel: "firesense.camera.poseModel", // PoseModelId: the watch camera's pose estimator (lib/client/pose-estimator.ts)
} as const;
