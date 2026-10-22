# Static hosting for /camera, /parent, /tv (browser trial) and the example player
# (+ self-hosted MediaPipe assets and the sample video) over HTTPS.
# Camera access requires a secure context, hence CloudFront.
resource "aws_s3_bucket" "web" {
  bucket_prefix = "${local.name}-web-"
  force_destroy = true
}

resource "aws_s3_bucket_public_access_block" "web" {
  bucket                  = aws_s3_bucket.web.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_cloudfront_origin_access_control" "web" {
  name                              = "${local.name}-web"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

# Next.js static export uses trailingSlash: /camera/ -> /camera/index.html
resource "aws_cloudfront_function" "index_rewrite" {
  name    = "${local.name}-index-rewrite"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var req = event.request;
      if (req.uri.endsWith('/')) {
        req.uri += 'index.html';
      } else if (!req.uri.split('/').pop().includes('.')) {
        req.uri += '/index.html';
      }
      return req;
    }
  JS
}

data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

# Preset videos (media/, scripts/upload-media.sh) are played by the TV app from another origin
# (https://appassets.androidplatform.net) with crossOrigin="anonymous", so the TV can read a frame
# back and check the picture is drawn: they need Access-Control-Allow-Origin (CloudFront adds it to
# requests that carry an Origin header, which every crossOrigin request does). "Vary: Origin" keeps
# the WebView's HTTP cache from reusing a copy fetched without Origin (no CORS header) for a CORS
# request, which then fails as "Format error".
resource "aws_cloudfront_response_headers_policy" "media_cors" {
  name    = "${local.name}-media-cors"
  comment = "CORS for media/ (TV app origin), Vary: Origin"
  cors_config {
    access_control_allow_credentials = false
    access_control_allow_headers {
      items = ["*"]
    }
    access_control_allow_methods {
      items = ["GET", "HEAD", "OPTIONS"]
    }
    access_control_allow_origins {
      items = ["*"]
    }
    access_control_expose_headers {
      items = ["Content-Length", "Content-Range", "Accept-Ranges"]
    }
    origin_override = true
  }
  custom_headers_config {
    items {
      header   = "Vary"
      value    = "Origin"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "web" {
  enabled             = true
  comment             = "FireSense Kids web (/camera, /parent, /tv, examples)"
  default_root_object = "index.html"
  price_class         = "PriceClass_100"
  http_version        = "http2and3"

  origin {
    domain_name              = aws_s3_bucket.web.bucket_regional_domain_name
    origin_id                = "s3-web"
    origin_access_control_id = aws_cloudfront_origin_access_control.web.id
  }

  default_cache_behavior {
    target_origin_id       = "s3-web"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.index_rewrite.arn
    }
  }

  ordered_cache_behavior {
    path_pattern               = "media/*"
    target_origin_id           = "s3-web"
    viewer_protocol_policy     = "redirect-to-https"
    allowed_methods            = ["GET", "HEAD", "OPTIONS"]
    cached_methods             = ["GET", "HEAD"]
    cache_policy_id            = data.aws_cloudfront_cache_policy.optimized.id
    response_headers_policy_id = aws_cloudfront_response_headers_policy.media_cors.id
    compress                   = false
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}

data "aws_iam_policy_document" "web_bucket" {
  statement {
    actions   = ["s3:GetObject"]
    resources = ["${aws_s3_bucket.web.arn}/*"]
    principals {
      type        = "Service"
      identifiers = ["cloudfront.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "AWS:SourceArn"
      values   = [aws_cloudfront_distribution.web.arn]
    }
  }
}

resource "aws_s3_bucket_policy" "web" {
  bucket = aws_s3_bucket.web.id
  policy = data.aws_iam_policy_document.web_bucket.json
}
