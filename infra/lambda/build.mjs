#!/usr/bin/env node
// Bundles each Lambda handler into infra/lambda/dist/<name>/index.mjs (Node.js 22, ESM).
// The AWS SDK v3 is provided by the Lambda runtime and left external.
import { build } from "esbuild";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const handlers = ["connection", "relay", "summary", "report"];
rmSync(join(here, "dist"), { recursive: true, force: true });

await Promise.all(
  handlers.map((name) =>
    build({
      entryPoints: [join(here, "src/handlers", `${name}.ts`)],
      outfile: join(here, "dist", name, "index.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      sourcemap: "inline",
      external: ["@aws-sdk/*"],
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
      logLevel: "warning",
    })
  )
);
console.log(`[lambda] built ${handlers.join(", ")} → infra/lambda/dist/`);
