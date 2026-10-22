# No-fallback policy (fail fast, show the raw error)

FireSense Kids never hides a failure behind a substitute. There is no mock answer, no automatic switch to another
model, no silent CPU fallback and no guessed value. When something fails, the error is raised at once and shown as it
is, with its diagnostic details.

**Why.** A silent fallback hides the real problem (missing credentials, a quota, a wrong model ID, a dropped network),
makes a tester judge the output of something other than what they think is running, and makes the failing layer
impossible to trace. For a child-facing system it has one more cost: a guess can leave the picture blurred for no
reason. So the rule is the same everywhere: fail fast, fail toward a clear picture, and say why.

## Where the model is chosen

The only AI is Claude Sonnet 4.6 on Amazon Bedrock (`us.anthropic.claude-sonnet-4-6`). The code has no path to
another model.

| Place | What it does |
|---|---|
| Terraform `var.bedrock_model_id` | Passed to the Lambda as `BEDROCK_MODEL_ID`; IAM allows `bedrock:InvokeModel` on that inference profile only |
| `infra/lambda/src/lib/bedrock.ts` | Throws when `BEDROCK_MODEL_ID` is not set; a request cannot change the model |
| `/parent` | Shows `modelId / requestId / latencyMs / inputTokens / outputTokens` from each response as they are |

## What happens on failure

| Event | Behavior |
|---|---|
| Bedrock 4xx/5xx or timeout | The Lambda returns HTTP 500 with the raw error name, message and AWS requestId; the parent phone shows them in a red card |
| `stop_reason` is `refusal` / `max_tokens`, or the JSON does not match the schema | HTTP 502 with the raw output (`rawText`) and a trace |
| The output mentions eyesight or health (forbidden by the prompt) | Not shown; the page says which phrase was found |
| No records yet | Claude is not called; the page says "No records yet" (no seed data is shown) |
| TV marker: the screen is not found, not a quadrilateral, or the field of view cannot be solved | An error with the reason; no floor model is saved (no guessed value) |
| The TV does not report the calibration pattern within 5 s | An error; the TV screen is always restored (the TV restores itself after 20 s) |
| MediaPipe GPU start fails | An error; CPU is a "Retry on CPU" button the user presses, never a silent switch |
| The relay drops | The TV clears the blur and keeps showing "Sensor not connected"; it reconnects to the same endpoint |
| A `NEXT_PUBLIC_*` setting is missing | `next build` fails |
