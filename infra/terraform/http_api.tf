# Insight Plane REST API (Lambda + Bedrock Claude Sonnet 4.6 + DynamoDB).
resource "aws_apigatewayv2_api" "http" {
  name          = "${local.name}-api"
  protocol_type = "HTTP"

  cors_configuration {
    allow_origins = concat(
      ["https://${aws_cloudfront_distribution.web.domain_name}", "https://appassets.androidplatform.net"],
      var.extra_cors_origins
    )
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["authorization", "content-type"]
    max_age       = 600
  }
}

locals {
  http_routes = {
    "POST /session/summary"  = "summary"
    "GET /session/summary"   = "summary"
    "POST /session/summary/reset" = "summary"
    "POST /session/reminder" = "summary"
    "GET /report/weekly"     = "report"
  }
}

resource "aws_apigatewayv2_integration" "http" {
  for_each               = toset(local.insight_functions)
  api_id                 = aws_apigatewayv2_api.http.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.fn[each.key].invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "http" {
  for_each  = local.http_routes
  api_id    = aws_apigatewayv2_api.http.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.http[each.value].id}"
}

resource "aws_apigatewayv2_stage" "http" {
  api_id      = aws_apigatewayv2_api.http.id
  name        = "$default"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 20
    throttling_rate_limit  = 10
  }
}

resource "aws_lambda_permission" "http" {
  for_each      = toset(local.insight_functions)
  statement_id  = "AllowHttpApiInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.http.execution_arn}/*/*"
}
