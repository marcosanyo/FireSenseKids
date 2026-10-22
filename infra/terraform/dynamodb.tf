# Sessions + connections (single table, pk only). Items expire via TTL.
resource "aws_dynamodb_table" "sessions" {
  name         = "${local.name}-sessions"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"

  attribute {
    name = "pk"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# One cumulative summary per session per day (numbers only). 30-day TTL.
resource "aws_dynamodb_table" "daily_summaries" {
  name         = "${local.name}-daily-summaries"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "sessionId"
  range_key    = "date"

  attribute {
    name = "sessionId"
    type = "S"
  }

  attribute {
    name = "date"
    type = "S"
  }

  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
