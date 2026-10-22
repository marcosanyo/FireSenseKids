"use client";

import { useEffect, useState } from "react";
import { lang } from "@/lib/firesense/i18n";
import { initLang, switchLang } from "@/lib/client/lang";

/**
 * Renders the page only after the device's language is known, so the first render is already in that
 * language (the static export is prerendered without it, and every page is a client app anyway).
 */
export function LangGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    initLang();
    setReady(true);
  }, []);
  return ready ? <>{children}</> : null;
}

/** Small "EN | 日本語" switch for the phone pages. Switching reloads the page. */
export function LangSwitch({ className = "" }: { className?: string }) {
  const current = lang();
  return (
    <div className={`inline-flex rounded-full border border-slate-700 overflow-hidden text-[11px] font-bold ${className}`}>
      {(
        [
          ["en", "EN"],
          ["ja", "日本語"],
        ] as const
      ).map(([l, label]) => (
        <button
          key={l}
          onClick={() => l !== current && switchLang(l)}
          className={`px-2.5 py-1 ${l === current ? "bg-slate-200 text-slate-900" : "bg-slate-900 text-slate-400"}`}
          aria-pressed={l === current}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
