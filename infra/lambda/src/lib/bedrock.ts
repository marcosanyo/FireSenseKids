/**
 * Amazon Bedrock — Claude Sonnet 4.6 (cross-region inference profile, us-east-1).
 *
 * The only AI model in FireSense Kids. Used for the Insight Plane (weekly reflection,
 * mascot lines). Never for safety decisions or setup: no image is ever sent to it.
 *
 * Fail-fast: any Bedrock error, a refusal, a truncated response, or JSON that does not
 * match the expected schema is thrown as-is. There is no mock and no alternate model.
 */

import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import type { ZodType } from "zod";
import type { BedrockTrace } from "../../../../lib/firesense/protocol";

export const DEFAULT_MODEL_ID = "us.anthropic.claude-sonnet-4-6";

export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; source: { type: "base64"; media_type: "image/jpeg" | "image/png" | "image/webp"; data: string } };

export interface ClaudeRequest {
  system: string;
  content: ContentBlock[];
  maxTokens: number;
}

export class BedrockOutputError extends Error {
  constructor(message: string, public readonly rawText: string, public readonly trace: BedrockTrace) {
    super(message);
  }
}

let client: BedrockRuntimeClient | null = null;

export function modelId(): string {
  const id = process.env.BEDROCK_MODEL_ID;
  if (!id) throw new Error("Missing required environment variable BEDROCK_MODEL_ID");
  return id;
}

function bedrock(): BedrockRuntimeClient {
  if (!client) {
    const region = process.env.BEDROCK_REGION ?? process.env.AWS_REGION;
    if (!region) throw new Error("Missing BEDROCK_REGION / AWS_REGION for Bedrock");
    client = new BedrockRuntimeClient({ region });
  }
  return client;
}

export async function invokeClaude(req: ClaudeRequest): Promise<{ text: string; trace: BedrockTrace }> {
  const id = modelId();
  const started = Date.now();
  const res = await bedrock().send(
    new InvokeModelCommand({
      modelId: id,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({
        anthropic_version: "bedrock-2023-05-31",
        max_tokens: req.maxTokens,
        system: req.system,
        messages: [{ role: "user", content: req.content }],
      }),
    })
  );
  const latencyMs = Date.now() - started;
  const body = JSON.parse(new TextDecoder().decode(res.body)) as {
    content?: { type: string; text?: string }[];
    stop_reason?: string;
    usage?: { input_tokens?: number; output_tokens?: number };
  };

  const requestId = res.$metadata.requestId;
  if (!requestId) throw new Error("Bedrock response is missing a requestId");
  const inputTokens = body.usage?.input_tokens;
  const outputTokens = body.usage?.output_tokens;
  if (typeof inputTokens !== "number" || typeof outputTokens !== "number") {
    throw new Error(`Bedrock response is missing token usage: ${JSON.stringify(body.usage)}`);
  }
  const trace: BedrockTrace = { modelId: id, requestId, latencyMs, inputTokens, outputTokens };
  console.log(JSON.stringify({ evt: "bedrock_invoke", ...trace, stopReason: body.stop_reason }));

  const text = (body.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (body.stop_reason === "refusal") throw new BedrockOutputError("Claude declined the request (stop_reason=refusal)", text, trace);
  if (body.stop_reason === "max_tokens") throw new BedrockOutputError("Claude response was truncated (stop_reason=max_tokens)", text, trace);
  return { text, trace };
}

/** Extracts the first JSON object from the model text and validates it. Throws with the raw text on mismatch. */
export function parseModelJson<T>(text: string, schema: ZodType<T>, trace: BedrockTrace): T {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new BedrockOutputError("Claude did not return a JSON object", text, trace);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch (e) {
    throw new BedrockOutputError(`Claude returned invalid JSON: ${(e as Error).message}`, text, trace);
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new BedrockOutputError(`Claude JSON does not match schema: ${r.error.message}`, text, trace);
  return r.data;
}
