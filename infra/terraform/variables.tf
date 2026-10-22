variable "aws_region" {
  type        = string
  default     = "us-east-1"
  description = "All resources live in us-east-1 (aligned with Bedrock US cross-region inference)."
}

variable "environment" {
  type        = string
  default     = "dev"
  description = "Environment name used in resource names."
}

variable "bedrock_model_id" {
  type        = string
  default     = "us.anthropic.claude-sonnet-4-6"
  description = "Bedrock inference profile ID for Claude Sonnet 4.6 (the only model used)."
}

variable "bedrock_foundation_model" {
  type        = string
  default     = "anthropic.claude-sonnet-4-6"
  description = "Foundation model behind the inference profile (IAM scope)."
}

variable "extra_cors_origins" {
  type        = list(string)
  default     = []
  description = "Additional browser origins allowed to call the HTTP API (e.g. https://localhost:3443 for dev)."
}

variable "log_retention_days" {
  type    = number
  default = 14
}

# --- Abuse / cost controls for the public stack (T4) ----------------------------
variable "report_daily_limit" {
  type        = number
  default     = 30
  description = "Max Bedrock calls (weekly report) per pairing session per UTC day. Over it: HTTP 429 RATE_LIMITED."
  validation {
    condition     = var.report_daily_limit >= 1 && floor(var.report_daily_limit) == var.report_daily_limit
    error_message = "report_daily_limit must be a positive integer."
  }
}

# No defaults on purpose: plan/apply fails until you choose a budget and who gets the alerts
# (TF_VAR_monthly_budget_usd / TF_VAR_budget_alert_email in .env, or a terraform.tfvars).
variable "monthly_budget_usd" {
  type        = number
  description = "Monthly AWS cost budget in USD for this account (AWS Budgets alerts at 80% actual and 100% forecast)."
  validation {
    condition     = var.monthly_budget_usd > 0
    error_message = "monthly_budget_usd must be greater than 0."
  }
}

variable "budget_alert_email" {
  type        = string
  description = "Email address that receives the AWS Budgets alerts."
  validation {
    condition     = can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", var.budget_alert_email))
    error_message = "budget_alert_email must be an email address."
  }
}
