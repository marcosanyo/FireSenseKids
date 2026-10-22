import { L } from "@/lib/firesense/i18n";
import Link from "next/link";
import { Camera, HeartHandshake, ShieldCheck } from "lucide-react";
import { LangSwitch } from "@/components/lang";

export default function HomePage() {
  return (
    <main className="max-w-xl mx-auto px-4 py-10 space-y-6">
      <header className="space-y-2 text-center">
        <LangSwitch />
        <h1 className="text-3xl font-extrabold text-white">🐾 FireSense Kids</h1>
        <p className="text-slate-300">
          {L("A Fire TV experience that reacts to how close the viewer is: the closer, the less clear the picture; step back and it restores.", "近づくと画面がやさしくぼやけ、自分で下がるとほめられる。Fire TV のための「離れて見る」を育てるアプリ。")}
        </p>
      </header>
      <div className="grid gap-3">
        <Link href="/camera/" className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-center gap-3">
          <Camera className="w-6 h-6 text-orange-400" />
          <div>
            <div className="font-bold text-white">{L("Watch camera", "見守りカメラ")}</div>
            <div className="text-xs text-slate-400">{L("Usually opened from the QR code on the TV", "ふだんはTVのQRコードから開きます")}</div>
          </div>
        </Link>
        <Link href="/parent/" className="p-4 rounded-2xl bg-slate-900 border border-slate-800 flex items-center gap-3">
          <HeartHandshake className="w-6 h-6 text-orange-400" />
          <div>
            <div className="font-bold text-white">{L("Parent page", "保護者ページ")}</div>
            <div className="text-xs text-slate-400">{L("Rules, videos and records; weekly reflection by Claude Sonnet 4.6 on Amazon Bedrock", "1週間のふりかえり（Claude Sonnet 4.6 on Amazon Bedrock）")}</div>
          </div>
        </Link>
      </div>
      <p className="text-xs text-slate-500 flex items-start gap-2">
        <ShieldCheck className="w-4 h-4 shrink-0" />
        {L("Video never leaves the watch camera. Only numbers such as distance and state reach the cloud.", "子どもの映像は見守りカメラの外に出ません。クラウドに届くのは距離・状態などの数値だけです。")}
      </p>
    </main>
  );
}
