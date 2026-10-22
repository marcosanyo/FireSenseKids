terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    archive = {
      source  = "hashicorp/archive"
      version = "~> 2.4"
    }
  }
}

provider "aws" {
  region = var.aws_region
  default_tags {
    tags = {
      Project     = "FireSenseKids"
      Environment = var.environment
      Hackathon   = "AmazonDeveloperHackathon2026"
    }
  }
}

data "aws_caller_identity" "current" {}

locals {
  name       = "firesense-kids-${var.environment}"
  account_id = data.aws_caller_identity.current.account_id
  lambda_dir = "${path.module}/../lambda/dist"
}
