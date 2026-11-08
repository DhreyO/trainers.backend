#!/usr/bin/env bash
# Start the stack in the right order and point CloudFront at EC2's new address.
#   RDS → wait until available → EC2 → wait until running → update CloudFront origin → health check
# Usage: ./scripts/aws-start.sh     (needs: aws CLI v2, jq, scripts/aws.env)
set -euo pipefail
cd "$(dirname "$0")"
source ./aws.env
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"
command -v jq >/dev/null || { echo "jq is required: brew install jq"; exit 1; }

# 1. RDS
status=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)
echo "RDS $DB_ID is $status"
if [ "$status" = "stopped" ]; then
  aws rds start-db-instance --db-instance-identifier "$DB_ID" >/dev/null
  echo "Starting RDS (5–10 min)..."
fi
aws rds wait db-instance-available --db-instance-identifier "$DB_ID"
echo "✓ RDS available"

# 2. EC2 (pm2 starts the backend on boot)
aws ec2 start-instances --instance-ids "$EC2_ID" >/dev/null
echo "Starting EC2..."
aws ec2 wait instance-running --instance-ids "$EC2_ID"
EC2_DNS=$(aws ec2 describe-instances --instance-ids "$EC2_ID" \
  --query 'Reservations[0].Instances[0].PublicDnsName' --output text)
echo "✓ EC2 running at $EC2_DNS"

# 3. CloudFront: the EC2 public DNS changes on every stop/start, so update the origin
cfg=$(mktemp)
trap 'rm -f "$cfg" "$cfg.new"' EXIT
aws cloudfront get-distribution-config --id "$CF_DISTRIBUTION_ID" > "$cfg"
etag=$(jq -r '.ETag' "$cfg")
current=$(jq -r --arg id "$CF_EC2_ORIGIN_ID" \
  '.DistributionConfig.Origins.Items[] | select(.Id == $id) | .DomainName' "$cfg")
if [ -z "$current" ]; then
  echo "No CloudFront origin with Id '$CF_EC2_ORIGIN_ID'. Check CF_EC2_ORIGIN_ID in aws.env"; exit 1
fi
if [ "$current" = "$EC2_DNS" ]; then
  echo "✓ CloudFront origin already points at $EC2_DNS"
else
  jq --arg id "$CF_EC2_ORIGIN_ID" --arg dns "$EC2_DNS" \
    '.DistributionConfig | (.Origins.Items[] | select(.Id == $id) | .DomainName) = $dns' "$cfg" > "$cfg.new"
  aws cloudfront update-distribution --id "$CF_DISTRIBUTION_ID" --if-match "$etag" \
    --distribution-config "file://$cfg.new" >/dev/null
  echo "Updating CloudFront origin $current → $EC2_DNS (a few minutes)..."
  aws cloudfront wait distribution-deployed --id "$CF_DISTRIBUTION_ID"
  echo "✓ CloudFront updated"
fi

# 4. Health check through CloudFront
CF_DOMAIN=$(aws cloudfront get-distribution --id "$CF_DISTRIBUTION_ID" \
  --query 'Distribution.DomainName' --output text)
for i in $(seq 1 20); do
  if curl -fsS -m 5 "https://$CF_DOMAIN/health" 2>/dev/null; then
    echo; echo "✓ Site is up: https://$CF_DOMAIN"; exit 0
  fi
  sleep 6
done
echo "Backend not healthy yet. SSH/Session Manager in and check: pm2 status, pm2 logs trainers"
exit 1
