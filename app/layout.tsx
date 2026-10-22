import type { Metadata } from "next";
import "./globals.css";
import { LangGate } from "@/components/lang";

export const metadata: Metadata = {
  title: "FireSense Kids — Body-Aware Viewing for Fire TV",
  description: "A Fire TV experience that reacts to how close the viewer is.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased min-h-screen bg-slate-950 text-slate-100">
        <LangGate>{children}</LangGate>
      </body>
    </html>
  );
}
