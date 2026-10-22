import type { BedrockTrace } from "@/lib/firesense/protocol";
import { AlertTriangle } from "lucide-react";

export function Banner({ tone, title, children }: { tone: "error" | "warn"; title: string; children: React.ReactNode }) {
  const cls = tone === "error" ? "bg-rose-950/60 border-rose-500/50 text-rose-100" : "bg-amber-950/60 border-amber-500/50 text-amber-100";
  return (
    <div className={`p-3 rounded-xl border text-xs flex gap-2 ${cls}`}>
      <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
      <div>
        <div className="font-bold">{title}</div>
        <div className="mt-0.5 leading-relaxed">{children}</div>
      </div>
    </div>
  );
}

export function Pill({ ok, children }: { ok?: boolean; children: React.ReactNode }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-full border ${
        ok ? "bg-emerald-500/10 border-emerald-500/40 text-emerald-300" : "bg-slate-800 border-slate-700 text-slate-400"
      }`}
    >
      {children}
    </span>
  );
}

export function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-2 rounded-lg bg-slate-950 border border-slate-800">
      <div className="text-slate-500">{label}</div>
      <div className="font-mono font-bold text-white">{value}</div>
    </div>
  );
}

export function TraceLine({ trace }: { trace: BedrockTrace }) {
  return (
    <p className="font-mono text-[10px] text-slate-500 break-all">
      {trace.modelId} · requestId {trace.requestId} · {trace.latencyMs}ms · in {trace.inputTokens} / out {trace.outputTokens} tokens
    </p>
  );
}
