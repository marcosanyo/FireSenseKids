import type { NextConfig } from "next";

// Endpoints are baked in at build time. A build without them is a broken build:
// fail here instead of shipping pages that silently point nowhere.
const REQUIRED = ["NEXT_PUBLIC_WS_URL", "NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_WEB_ORIGIN"] as const;
const missing = REQUIRED.filter((k) => !process.env[k]);
if (missing.length > 0) {
  throw new Error(
    `Missing ${missing.join(", ")}. Set them from \`terraform output\` (see README "Deploy"), e.g. in .env.local.`
  );
}
if (!process.env.NEXT_PUBLIC_WS_URL!.startsWith("wss://")) {
  throw new Error(`NEXT_PUBLIC_WS_URL must start with wss:// (got ${process.env.NEXT_PUBLIC_WS_URL})`);
}
for (const k of ["NEXT_PUBLIC_API_URL", "NEXT_PUBLIC_WEB_ORIGIN"] as const) {
  if (!process.env[k]!.startsWith("https://")) throw new Error(`${k} must start with https:// (got ${process.env[k]})`);
}

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // One static build → /camera and /parent to S3+CloudFront, /tv into the Fire TV APK assets.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
