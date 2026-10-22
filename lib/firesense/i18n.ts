/**
 * FireSense Kids — UI language.
 *
 * English is the main language (the submission is judged in English); Japanese is available for the team.
 * Every user-visible string is written as `L("English", "日本語")` next to where it is used, so the two
 * cannot drift apart and nothing is looked up by key.
 *
 * The language is plain module state: the browser sets it once at startup (lib/client/lang.ts) before
 * any page renders, and code that runs elsewhere (Lambda, tests) gets English. Changing the language
 * reloads the page, so nothing has to re-render on a change.
 */

export type Lang = "en" | "ja";
export const LANGS: readonly Lang[] = ["en", "ja"];

let current: Lang = "en";

export function setLang(lang: Lang): void {
  current = lang;
}

export function lang(): Lang {
  return current;
}

/** The string for the current language. */
export function L(en: string, ja: string): string {
  return current === "ja" ? ja : en;
}

/** BCP 47 tag for speech synthesis and `<html lang>`. */
export function speechLang(): string {
  return current === "ja" ? "ja-JP" : "en-US";
}
