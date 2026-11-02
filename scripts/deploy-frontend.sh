#!/usr/bin/env bash
# Build the frontend and publish it to the private S3 bucket behind CloudFront.
# Usage: ./scripts/deploy-frontend.sh     (needs: aws CLI v2, npm, scripts/aws.env)
set -euo pipefail
cd "$(dirname "$0")"
source ./aws.env
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

cd "$FRONTEND_DIR"
npm run build

# Hashed files in assets/ never change → cache for a year; index.html must always be fresh
aws s3 sync dist/assets "s3://$SITE_BUCKET/assets" --delete \
  --cache-control "public,max-age=31536000,immutable"
aws s3 sync dist "s3://$SITE_BUCKET" --delete --exclude "assets/*" \
  --cache-control "no-cache"

aws cloudfront create-invalidation --distribution-id "$CF_DISTRIBUTION_ID" \
  --paths "/index.html" "/" >/dev/null
echo "✓ Frontend deployed. CloudFront refreshes index.html within a minute."
