import { MODES, type FireSenseMode } from "../firesense/protocol";
import { KEYS } from "./storage";
import { L } from "../firesense/i18n";

/**
 * Field-pilot mode of this phone (T2), saved on the device. Both /camera and /parent run on the
 * watch phone, so they read the same value.
 *
 * Nothing stored yet = "intervene", the normal product, and the screen always shows which mode is on.
 * A stored value that is not a known mode is an error, not a guess.
 */
export function loadMode(): FireSenseMode {
  const raw = window.localStorage.getItem(KEYS.cameraMode);
  if (raw === null) return "intervene";
  if ((MODES as readonly string[]).includes(raw)) return raw as FireSenseMode;
  throw new Error(L(`The saved mode "${raw}" is unknown (expected intervene or shadow)`, `保存されているモード "${raw}" は不明です（intervene / shadow のどちらか）`));
}

export function saveMode(mode: FireSenseMode): void {
  window.localStorage.setItem(KEYS.cameraMode, mode);
}

// Getters: the language is set after this module loads.
export const MODE_LABEL: Record<FireSenseMode, { readonly title: string; readonly detail: string }> = {
  intervene: {
    get title() { return L("Respond", "介入モード"); },
    get detail() { return L("The closer, the stronger the blur and dimming, plus a small marker (pause and other rules: on the parent phone)", "近いほど強くぼかして暗く・目印（一時停止などの見せ方は保護者のスマホで設定）"); },
  },
  shadow: {
    get title() { return L("Record only", "記録のみ（シャドー）"); },
    get detail() { return L("The TV changes nothing; only numbers are recorded", "TVは何も変えず、数値だけ記録します"); },
  },
};
