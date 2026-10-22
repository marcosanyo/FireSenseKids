output "websocket_url" {
  value       = "${aws_apigatewayv2_api.ws.api_endpoint}/${aws_apigatewayv2_stage.ws.name}"
  description = "NEXT_PUBLIC_WS_URL"
}

output "http_api_url" {
  value       = aws_apigatewayv2_api.http.api_endpoint
  description = "NEXT_PUBLIC_API_URL"
}

output "cloudfront_url" {
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
  description = "NEXT_PUBLIC_WEB_ORIGIN (QR codes point to <cloudfront_url>/camera/)"
}

output "tv_url" {
  value       = "https://${aws_cloudfront_distribution.web.domain_name}/tv/"
  description = "The TV screen in a desktop browser (README: Try it in 5 minutes)"
}

output "example_player_url" {
  value       = "https://${aws_cloudfront_distribution.web.domain_name}/examples/plain-video-player/"
  description = "The framework-free player that integrates FireSenseViewer"
}

output "web_bucket" {
  value = aws_s3_bucket.web.bucket
}

output "cloudfront_distribution_id" {
  value = aws_cloudfront_distribution.web.id
}

output "sessions_table" {
  value = aws_dynamodb_table.sessions.name
}

output "daily_summaries_table" {
  value = aws_dynamodb_table.daily_summaries.name
}
