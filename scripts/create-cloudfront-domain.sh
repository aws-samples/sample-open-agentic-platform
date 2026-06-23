#!/bin/bash
set -e

################################################################################
# Create a CloudFront distribution for the Agent Platform ingress
#
# This script creates a CloudFront distribution that fronts the platform's
# ingress NLB. It can be run BEFORE the platform install (with a placeholder
# origin) or AFTER (with the real NLB DNS name).
#
# The resulting CloudFront domain (e.g., d1234abcdef.cloudfront.net) should be
# set as the 'domain' field in config.local.yaml before running `task install`.
#
# Usage:
#   # Pre-install (creates with placeholder origin, update later):
#   ./scripts/create-cloudfront-domain.sh
#
#   # Post-install (with real NLB origin):
#   ORIGIN_DOMAIN=hub-ingress-xxxxx.elb.us-east-1.amazonaws.com \
#     ./scripts/create-cloudfront-domain.sh
#
#   # Update existing distribution origin (after NLB is ready):
#   ./scripts/create-cloudfront-domain.sh --update-origin <distribution-id> <nlb-dns-name>
#
################################################################################

echo "=========================================="
echo "CloudFront Distribution Setup"
echo "=========================================="
echo ""

# ─── Configuration (parameterize these as needed) ────────────────────────────

# AWS region for API calls (CloudFront is global but API calls go to us-east-1)
AWS_REGION="${AWS_REGION:-us-east-1}"

# Resource prefix for naming/tagging (should match config.local.yaml resourcePrefix)
RESOURCE_PREFIX="${RESOURCE_PREFIX:-peeks}"

# Ingress name (should match config.local.yaml ingressName)
INGRESS_NAME="${INGRESS_NAME:-hub-ingress}"

# Origin domain name — the NLB DNS name or a placeholder if creating pre-install
# If empty, uses a placeholder that must be updated after the NLB is provisioned
ORIGIN_DOMAIN="${ORIGIN_DOMAIN:-}"

# Origin protocol policy: http-only | https-only | match-viewer
# The terraform setup uses http-only (CloudFront terminates TLS, talks HTTP to NLB)
ORIGIN_PROTOCOL_POLICY="${ORIGIN_PROTOCOL_POLICY:-http-only}"

# Origin timeouts (from terraform cloudfront.tf)
ORIGIN_READ_TIMEOUT="${ORIGIN_READ_TIMEOUT:-60}"        # seconds (max 60)
ORIGIN_KEEPALIVE_TIMEOUT="${ORIGIN_KEEPALIVE_TIMEOUT:-30}"  # seconds (max 60)

# ─── Handle --update-origin mode ─────────────────────────────────────────────

if [ "$1" = "--update-origin" ]; then
  DIST_ID="$2"
  NLB_DOMAIN="$3"
  if [ -z "$DIST_ID" ] || [ -z "$NLB_DOMAIN" ]; then
    echo "Usage: $0 --update-origin <distribution-id> <nlb-dns-name>"
    exit 1
  fi
  echo "Updating CloudFront distribution $DIST_ID origin to: $NLB_DOMAIN"

  # Get current config
  ETAG=$(aws cloudfront get-distribution-config --id "$DIST_ID" --query "ETag" --output text)
  aws cloudfront get-distribution-config --id "$DIST_ID" --query "DistributionConfig" > /tmp/cf-dist-config.json

  # Update the origin domain name
  jq --arg domain "$NLB_DOMAIN" '
    .Origins.Items[0].DomainName = $domain
  ' /tmp/cf-dist-config.json > /tmp/cf-dist-config-updated.json

  aws cloudfront update-distribution \
    --id "$DIST_ID" \
    --if-match "$ETAG" \
    --distribution-config file:///tmp/cf-dist-config-updated.json

  echo ""
  echo "✅ Origin updated to: $NLB_DOMAIN"
  echo "   Distribution will take a few minutes to deploy."
  rm -f /tmp/cf-dist-config.json /tmp/cf-dist-config-updated.json
  exit 0
fi

# ─── Pre-flight checks ───────────────────────────────────────────────────────

echo "Step 1: Checking prerequisites..."

if ! command -v aws &> /dev/null; then
  echo "❌ AWS CLI not found"
  exit 1
fi

if ! command -v jq &> /dev/null; then
  echo "❌ jq not found"
  exit 1
fi

if ! aws sts get-caller-identity &> /dev/null; then
  echo "❌ AWS credentials not configured or expired"
  exit 1
fi

echo "✅ Prerequisites met"
echo ""

# ─── Lookup managed policy IDs ───────────────────────────────────────────────

echo "Step 2: Looking up CloudFront managed policy IDs..."

# Cache Policy: UseOriginCacheControlHeaders-QueryStrings
# This policy respects origin Cache-Control headers and forwards query strings
CACHE_POLICY_ID=$(aws cloudfront list-cache-policies --type managed \
  --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='UseOriginCacheControlHeaders-QueryStrings'].CachePolicy.Id" \
  --output text)

if [ -z "$CACHE_POLICY_ID" ] || [ "$CACHE_POLICY_ID" = "None" ]; then
  echo "❌ Could not find 'UseOriginCacheControlHeaders-QueryStrings' cache policy"
  exit 1
fi
echo "  Cache Policy ID: $CACHE_POLICY_ID"

# Origin Request Policy: Managed-AllViewer (forwards all viewer headers, cookies, query strings)
ORIGIN_REQUEST_POLICY_ID=$(aws cloudfront list-origin-request-policies --type managed \
  --query "OriginRequestPolicyList.Items[?OriginRequestPolicy.OriginRequestPolicyConfig.Name=='Managed-AllViewer'].OriginRequestPolicy.Id" \
  --output text)

if [ -z "$ORIGIN_REQUEST_POLICY_ID" ] || [ "$ORIGIN_REQUEST_POLICY_ID" = "None" ]; then
  echo "❌ Could not find 'Managed-AllViewer' origin request policy"
  exit 1
fi
echo "  Origin Request Policy ID: $ORIGIN_REQUEST_POLICY_ID"

# Cache Policy: CachingDisabled (for Keycloak path — no caching for dynamic content)
CACHING_DISABLED_POLICY_ID=$(aws cloudfront list-cache-policies --type managed \
  --query "CachePolicyList.Items[?CachePolicy.CachePolicyConfig.Name=='Managed-CachingDisabled'].CachePolicy.Id" \
  --output text)

if [ -z "$CACHING_DISABLED_POLICY_ID" ] || [ "$CACHING_DISABLED_POLICY_ID" = "None" ]; then
  echo "❌ Could not find 'Managed-CachingDisabled' cache policy"
  exit 1
fi
echo "  CachingDisabled Policy ID: $CACHING_DISABLED_POLICY_ID"

echo "✅ Managed policies resolved"
echo ""

# ─── Determine origin ────────────────────────────────────────────────────────

if [ -z "$ORIGIN_DOMAIN" ]; then
  # Try to discover the NLB DNS name from the existing cluster
  echo "Step 3: Attempting to discover NLB domain..."
  ORIGIN_DOMAIN=$(aws elbv2 describe-load-balancers \
    --names "$INGRESS_NAME" \
    --region "$AWS_REGION" \
    --query "LoadBalancers[0].DNSName" \
    --output text 2>/dev/null || echo "")

  if [ -z "$ORIGIN_DOMAIN" ] || [ "$ORIGIN_DOMAIN" = "None" ]; then
    # Use a placeholder — CloudFront requires a valid-looking domain
    # This MUST be updated after the NLB is provisioned
    ORIGIN_DOMAIN="placeholder-origin.example.com"
    echo "  ⚠ NLB not found. Using placeholder origin: $ORIGIN_DOMAIN"
    echo "    You MUST update the origin after running 'task install':"
    echo "    ./scripts/create-cloudfront-domain.sh --update-origin <dist-id> <nlb-dns>"
    PLACEHOLDER_USED=true
  else
    echo "  Found NLB: $ORIGIN_DOMAIN"
    PLACEHOLDER_USED=false
  fi
else
  echo "Step 3: Using provided origin domain: $ORIGIN_DOMAIN"
  PLACEHOLDER_USED=false
fi
echo ""

# ─── Create custom origin request policy for Keycloak ────────────────────────

echo "Step 4: Creating Keycloak origin request policy..."

# Check if the policy already exists
KEYCLOAK_ORP_ID=$(aws cloudfront list-origin-request-policies --type custom \
  --query "OriginRequestPolicyList.Items[?OriginRequestPolicy.OriginRequestPolicyConfig.Name=='${RESOURCE_PREFIX}-KeycloakOriginRequestPolicy'].OriginRequestPolicy.Id" \
  --output text 2>/dev/null || echo "")

if [ -z "$KEYCLOAK_ORP_ID" ] || [ "$KEYCLOAK_ORP_ID" = "None" ]; then
  # Create the custom origin request policy for Keycloak
  # Forwards ALL cookies, headers, and query strings for proper Keycloak operation
  KEYCLOAK_ORP_ID=$(aws cloudfront create-origin-request-policy \
    --origin-request-policy-config '{
      "Name": "'"${RESOURCE_PREFIX}"'-KeycloakOriginRequestPolicy",
      "Comment": "Origin request policy for Keycloak with all required headers",
      "CookiesConfig": { "CookieBehavior": "all" },
      "HeadersConfig": { "HeaderBehavior": "allViewer" },
      "QueryStringsConfig": { "QueryStringBehavior": "all" }
    }' \
    --query "OriginRequestPolicy.Id" \
    --output text)
  echo "  Created: $KEYCLOAK_ORP_ID"
else
  echo "  Already exists: $KEYCLOAK_ORP_ID"
fi

echo "✅ Keycloak origin request policy ready"
echo ""

# ─── Create CloudFront distribution ──────────────────────────────────────────

echo "Step 5: Creating CloudFront distribution..."

# Check if a distribution with our tag already exists
EXISTING_DIST_ID=$(aws cloudfront list-distributions \
  --query "DistributionList.Items[?Comment=='CloudFront distribution for ${INGRESS_NAME} NLB'].Id" \
  --output text 2>/dev/null || echo "")

if [ -n "$EXISTING_DIST_ID" ] && [ "$EXISTING_DIST_ID" != "None" ]; then
  echo "  ⚠ Distribution already exists: $EXISTING_DIST_ID"
  CF_DOMAIN=$(aws cloudfront get-distribution --id "$EXISTING_DIST_ID" \
    --query "Distribution.DomainName" --output text)
  echo ""
  echo "=========================================="
  echo "CloudFront Domain: $CF_DOMAIN"
  echo "Distribution ID:   $EXISTING_DIST_ID"
  echo "=========================================="
  echo ""
  echo "Set this in config.local.yaml:"
  echo "  domain: \"$CF_DOMAIN\""
  exit 0
fi

# Unique caller reference to prevent duplicate distributions
CALLER_REF="${RESOURCE_PREFIX}-${INGRESS_NAME}-$(date +%s)"

# Build the distribution config JSON
# Key settings from terraform cloudfront.tf:
#   - origin_read_timeout: 60s
#   - origin_keepalive_timeout: 30s
#   - origin_protocol_policy: http-only (CloudFront terminates TLS)
#   - viewer_protocol_policy: redirect-to-https
#   - compress: false
#   - Custom headers: X-Forwarded-Proto=https, X-Forwarded-Port=443
#   - Keycloak path (/keycloak/*): no caching (TTL=0), all headers/cookies forwarded
DIST_CONFIG=$(cat <<EOF
{
  "CallerReference": "${CALLER_REF}",
  "Comment": "CloudFront distribution for ${INGRESS_NAME} NLB",
  "Enabled": true,
  "IsIPV6Enabled": true,
  "HttpVersion": "http2",
  "PriceClass": "PriceClass_All",
  "Origins": {
    "Quantity": 1,
    "Items": [
      {
        "Id": "http-origin",
        "DomainName": "${ORIGIN_DOMAIN}",
        "CustomOriginConfig": {
          "HTTPPort": 80,
          "HTTPSPort": 443,
          "OriginProtocolPolicy": "${ORIGIN_PROTOCOL_POLICY}",
          "OriginSslProtocols": { "Quantity": 1, "Items": ["TLSv1.2"] },
          "OriginReadTimeout": ${ORIGIN_READ_TIMEOUT},
          "OriginKeepaliveTimeout": ${ORIGIN_KEEPALIVE_TIMEOUT}
        },
        "CustomHeaders": {
          "Quantity": 2,
          "Items": [
            { "HeaderName": "X-Forwarded-Proto", "HeaderValue": "https" },
            { "HeaderName": "X-Forwarded-Port", "HeaderValue": "443" }
          ]
        }
      }
    ]
  },
  "DefaultCacheBehavior": {
    "TargetOriginId": "http-origin",
    "ViewerProtocolPolicy": "redirect-to-https",
    "AllowedMethods": {
      "Quantity": 7,
      "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
      "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
    },
    "Compress": false,
    "CachePolicyId": "${CACHE_POLICY_ID}",
    "OriginRequestPolicyId": "${ORIGIN_REQUEST_POLICY_ID}"
  },
  "CacheBehaviors": {
    "Quantity": 1,
    "Items": [
      {
        "PathPattern": "/keycloak/*",
        "TargetOriginId": "http-origin",
        "ViewerProtocolPolicy": "redirect-to-https",
        "AllowedMethods": {
          "Quantity": 7,
          "Items": ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"],
          "CachedMethods": { "Quantity": 2, "Items": ["GET", "HEAD"] }
        },
        "Compress": false,
        "CachePolicyId": "${CACHING_DISABLED_POLICY_ID}",
        "OriginRequestPolicyId": "${KEYCLOAK_ORP_ID}"
      }
    ]
  },
  "ViewerCertificate": {
    "CloudFrontDefaultCertificate": true,
    "MinimumProtocolVersion": "TLSv1"
  },
  "Restrictions": {
    "GeoRestriction": { "RestrictionType": "none", "Quantity": 0 }
  }
}
EOF
)

# Create the distribution
RESULT=$(aws cloudfront create-distribution \
  --distribution-config "$DIST_CONFIG" \
  --output json)

DIST_ID=$(echo "$RESULT" | jq -r '.Distribution.Id')
CF_DOMAIN=$(echo "$RESULT" | jq -r '.Distribution.DomainName')
DIST_STATUS=$(echo "$RESULT" | jq -r '.Distribution.Status')

# Tag the distribution for easier identification
aws cloudfront tag-resource \
  --resource "arn:aws:cloudfront::$(aws sts get-caller-identity --query Account --output text):distribution/${DIST_ID}" \
  --tags "Items=[{Key=Name,Value=${INGRESS_NAME}-cloudfront},{Key=ResourcePrefix,Value=${RESOURCE_PREFIX}}]"

echo "✅ CloudFront distribution created"
echo ""

# ─── Summary ─────────────────────────────────────────────────────────────────

echo "=========================================="
echo "CloudFront Distribution Created"
echo "=========================================="
echo ""
echo "  Distribution ID: $DIST_ID"
echo "  Domain Name:     $CF_DOMAIN"
echo "  Status:          $DIST_STATUS"
echo "  Origin:          $ORIGIN_DOMAIN"
echo ""
echo "Set this in config.local.yaml:"
echo "  domain: \"$CF_DOMAIN\""
echo ""

if [ "$PLACEHOLDER_USED" = "true" ]; then
  echo "⚠ IMPORTANT: You used a placeholder origin."
  echo "  After running 'task install' and the NLB is provisioned, update the origin:"
  echo ""
  echo "  # Get the NLB DNS name"
  echo "  NLB_DNS=\$(aws elbv2 describe-load-balancers --names ${INGRESS_NAME} --region ${AWS_REGION} --query 'LoadBalancers[0].DNSName' --output text)"
  echo ""
  echo "  # Update the CloudFront origin"
  echo "  ./scripts/create-cloudfront-domain.sh --update-origin ${DIST_ID} \$NLB_DNS"
  echo ""
fi

echo "Next steps:"
echo "  1. Update config.local.yaml with: domain: \"$CF_DOMAIN\""
echo "  2. Run: task install"
if [ "$PLACEHOLDER_USED" = "true" ]; then
  echo "  3. After NLB is up, update CloudFront origin (see above)"
fi
echo ""
