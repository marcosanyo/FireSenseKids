"use client";

/**
 * Picks this device's UI language before anything renders: `?lang=en|ja` in the URL (saved for next
 * time), else the saved choice, else English. On the Fire TV the choice is kept in SharedPreferences
 * through the same storage bridge as everything else.
 */

import { LANGS, setLang, type Lang } from "../firesense/i18n";
import { KEYS, storage } from "./storage";

function parse(raw: string | null): Lang | null {
  return raw && (LANGS as readonly string[]).includes(raw) ? (raw as Lang) : null;
}

export function initLang(): Lang {
  const fromUrl = parse(new URLSearchParams(window.location.search).get("lang"));
  if (fromUrl) storage.set(KEYS.lang, fromUrl);
  const lang = fromUrl ?? parse(storage.get(KEYS.lang)) ?? "en";
  setLang(lang);
  document.documentElement.lang = lang;
  return lang;
}

/** Saves the choice and reloads, without `?lang=` (it would override the new choice). */
export function switchLang(lang: Lang): void {
  storage.set(KEYS.lang, lang);
  const url = new URL(window.location.href);
  url.searchParams.delete("lang");
  window.location.replace(url.toString());
}
