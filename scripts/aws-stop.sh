#!/usr/bin/env bash
# Stop the stack in reverse order: EC2 first, then RDS.
# Note: a stopped RDS instance auto-starts after 7 days. For longer breaks, snapshot + delete instead.
# Usage: ./scripts/aws-stop.sh     (needs: aws CLI v2, scripts/aws.env)
set -euo pipefail
cd "$(dirname "$0")"
source ./aws.env
export AWS_REGION AWS_DEFAULT_REGION="$AWS_REGION"

aws ec2 stop-instances --instance-ids "$EC2_ID" >/dev/null
echo "Stopping EC2..."
aws ec2 wait instance-stopped --instance-ids "$EC2_ID"
echo "✓ EC2 stopped"

status=$(aws rds describe-db-instances --db-instance-identifier "$DB_ID" \
  --query 'DBInstances[0].DBInstanceStatus' --output text)
if [ "$status" = "available" ]; then
  aws rds stop-db-instance --db-instance-identifier "$DB_ID" >/dev/null
  echo "✓ RDS stopping (takes a few minutes; auto-restarts after 7 days)"
else
  echo "RDS is '$status', not stopping"
fi
