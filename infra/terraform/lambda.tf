# Lambda bundles are produced by `node infra/lambda/build.mjs` (esbuild, Node.js 22).
locals {
  ws_functions      = ["connection", "relay"]
  insight_functions = ["summary", "report"]
  lambda_env = {
    SESSIONS_TABLE   = aws_dynamodb_table.sessions.name
    SUMMARIES_TABLE  = aws_dynamodb_table.daily_summaries.name
    BEDROCK_MODEL_ID = var.bedrock_model_id
    BEDROCK_REGION   = var.aws_region
    # Per-session daily cap on Bedrock calls (T4); the insight Lambdas refuse to start without it.
    REPORT_DAILY_LIMIT = tostring(var.report_daily_limit)
  }
  lambda_timeouts = {
    connection = 10
    relay      = 10
    summary    = 10
    report     = 60
  }
}

data "archive_file" "lambda" {
  for_each    = toset(concat(local.ws_functions, local.insight_functions))
  type        = "zip"
  source_dir  = "${local.lambda_dir}/${each.key}"
  output_path = "${path.module}/.build/${each.key}.zip"
}

data "aws_iam_policy_document" "lambda_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["lambda.amazonaws.com"]
    }
  }
}

# --- WebSocket relay role: sessions table + postToConnection only -------------
resource "aws_iam_role" "ws" {
  name               = "${local.name}-ws-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "ws" {
  statement {
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.sessions.arn]
  }
  statement {
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.ws.execution_arn}/*/POST/@connections/*"]
  }
}

resource "aws_iam_role_policy" "ws" {
  role   = aws_iam_role.ws.id
  policy = data.aws_iam_policy_document.ws.json
}

resource "aws_iam_role_policy_attachment" "ws_logs" {
  role       = aws_iam_role.ws.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- Insight role: Bedrock Claude Sonnet 4.6 only + summaries ------------------
resource "aws_iam_role" "insight" {
  name               = "${local.name}-insight-lambda"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

data "aws_iam_policy_document" "insight" {
  statement {
    sid     = "InvokeClaudeSonnet46Only"
    actions = ["bedrock:InvokeModel"]
    resources = [
      "arn:aws:bedrock:${var.aws_region}:${local.account_id}:inference-profile/${var.bedrock_model_id}",
      # The US cross-region profile routes to these regions' foundation model.
      "arn:aws:bedrock:us-east-1::foundation-model/${var.bedrock_foundation_model}*",
      "arn:aws:bedrock:us-east-2::foundation-model/${var.bedrock_foundation_model}*",
      "arn:aws:bedrock:us-west-2::foundation-model/${var.bedrock_foundation_model}*",
    ]
  }
  statement {
    # GetItem: authentication. UpdateItem: the QUOTA#… counters (per-session daily Bedrock cap).
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.sessions.arn]
  }
  statement {
    # UpdateItem: the TV's summary upsert and the parent's reminder counter (T2) share one item.
    # DeleteItem: "reset the records" (parent phone → TV → POST /session/summary/reset).
    actions   = ["dynamodb:UpdateItem", "dynamodb:Query", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.daily_summaries.arn]
  }
}

resource "aws_iam_role_policy" "insight" {
  role   = aws_iam_role.insight.id
  policy = data.aws_iam_policy_document.insight.json
}

resource "aws_iam_role_policy_attachment" "insight_logs" {
  role       = aws_iam_role.insight.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

# --- Functions -----------------------------------------------------------------
resource "aws_cloudwatch_log_group" "lambda" {
  for_each          = data.archive_file.lambda
  name              = "/aws/lambda/${local.name}-${each.key}"
  retention_in_days = var.log_retention_days
}

resource "aws_lambda_function" "fn" {
  for_each         = data.archive_file.lambda
  function_name    = "${local.name}-${each.key}"
  role             = contains(local.ws_functions, each.key) ? aws_iam_role.ws.arn : aws_iam_role.insight.arn
  runtime          = "nodejs22.x"
  architectures    = ["arm64"]
  handler          = "index.handler"
  filename         = each.value.output_path
  source_code_hash = each.value.output_base64sha256
  memory_size      = contains(local.ws_functions, each.key) ? 256 : 512
  timeout          = local.lambda_timeouts[each.key]

  environment {
    variables = local.lambda_env
  }

  depends_on = [aws_cloudwatch_log_group.lambda]
}
