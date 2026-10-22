# Realtime relay: camera phone <-> Fire TV (and camera phone <-> parent phones). Routes are selected by the JSON "type" field.
resource "aws_apigatewayv2_api" "ws" {
  name                       = "${local.name}-relay"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.type"
}

locals {
  ws_routes = {
    "$connect"               = "connection"
    "$disconnect"            = "connection"
    "tv_hello"               = "connection"
    "camera_hello"           = "connection"
    "pairing_reset"          = "connection"
    "parent_pairing_request" = "connection"
    "parent_hello"           = "connection"
    "telemetry"              = "relay"
    "heartbeat"              = "relay"
    "viewing_state"          = "relay"
    "$default"               = "relay"
  }
}

resource "aws_apigatewayv2_integration" "ws" {
  for_each           = toset(local.ws_functions)
  api_id             = aws_apigatewayv2_api.ws.id
  integration_type   = "AWS_PROXY"
  integration_uri    = aws_lambda_function.fn[each.key].invoke_arn
  integration_method = "POST"
}

resource "aws_apigatewayv2_route" "ws" {
  for_each  = local.ws_routes
  api_id    = aws_apigatewayv2_api.ws.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.ws[each.value].id}"
}

resource "aws_apigatewayv2_stage" "ws" {
  api_id      = aws_apigatewayv2_api.ws.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 200
    throttling_rate_limit  = 100
  }
}

resource "aws_lambda_permission" "ws" {
  for_each      = toset(local.ws_functions)
  statement_id  = "AllowWebSocketInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.fn[each.key].function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.ws.execution_arn}/*/*"
}
