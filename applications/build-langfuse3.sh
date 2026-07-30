#!/bin/bash
set -e

# Build script for Langfuse v3 with custom base path (/langfuse)
# Builds from the official Langfuse source with NEXT_PUBLIC_BASE_PATH baked in.
# Pushes to the same public ECR used for strands-agent.
#
# Usage:
#   ./build-langfuse3.sh          # build only
#   ./build-langfuse3.sh push     # build + push to public ECR
#   ./build-langfuse3.sh clean    # build from scratch (no cache)

# ── Configuration ────────────────────────────────────────────────────────────
LANGFUSE_VERSION="${LANGFUSE_VERSION:-v3.201.1}"
BASE_PATH="${BASE_PATH:-/langfuse}"
IMAGE_NAME="${IMAGE_NAME:-langfuse-basepath}"
IMAGE_TAG="${IMAGE_TAG:-3-basepath}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUBLIC_ECR_ALIAS="${PUBLIC_ECR_ALIAS:-z0a4o2j5}"
PUBLIC_ECR_URI="public.ecr.aws/${PUBLIC_ECR_ALIAS}"
COMMAND="${1:-build}"
NO_CACHE=""
BUILD_DIR="/tmp/langfuse-build"

# Worker image (no custom build needed — prebuilt image works)
WORKER_IMAGE="langfuse/langfuse-worker:3"

if [ "$1" = "clean" ] || [ "$2" = "clean" ]; then
    NO_CACHE="--no-cache"
    echo "Clean build enabled (no cache)"
    if [ "$1" = "clean" ]; then COMMAND="${2:-build}"; fi
fi

echo "========================================="
echo "Building Langfuse v3 with Custom Base Path"
echo "========================================="
echo "Langfuse version: ${LANGFUSE_VERSION}"
echo "Base path:        ${BASE_PATH}"
echo "Image:            ${IMAGE_NAME}:${IMAGE_TAG}"
echo "Platform:         ${PLATFORM}"
echo "Public ECR:       ${PUBLIC_ECR_URI}/${IMAGE_NAME}"
echo "========================================="

# ── Clone Langfuse source ────────────────────────────────────────────────────
if [ "$COMMAND" = "build" ] || [ "$COMMAND" = "push" ]; then
    echo ""
    echo "Cloning Langfuse ${LANGFUSE_VERSION}..."
    rm -rf "${BUILD_DIR}"
    git clone --branch "${LANGFUSE_VERSION}" --depth 1 \
        https://github.com/langfuse/langfuse.git "${BUILD_DIR}"

    echo ""
    echo "Building Docker image with NEXT_PUBLIC_BASE_PATH=${BASE_PATH}..."
    docker build \
        --platform "${PLATFORM}" \
        ${NO_CACHE} \
        --build-arg NEXT_PUBLIC_BASE_PATH="${BASE_PATH}" \
        -t "${IMAGE_NAME}:${IMAGE_TAG}" \
        -f "${BUILD_DIR}/web/Dockerfile" \
        "${BUILD_DIR}"

    echo ""
    echo "Build completed!"
    echo ""
    echo "Environment variables required at runtime:"
    echo "  NEXT_PUBLIC_BASE_PATH=${BASE_PATH}"
    echo "  NEXTAUTH_URL=https://<domain>${BASE_PATH}/api/auth"
    echo ""
    echo "Worker image (no custom build needed):"
    echo "  ${WORKER_IMAGE}"
fi

# ── Push to Public ECR ───────────────────────────────────────────────────────
if [ "$COMMAND" = "push" ]; then
    echo ""
    echo "========================================="
    echo "Pushing to Public ECR"
    echo "========================================="

    FULL_URI="${PUBLIC_ECR_URI}/${IMAGE_NAME}"
    echo "Target: ${FULL_URI}:${IMAGE_TAG}"

    # Authenticate to public ECR (us-east-1 is required for public ECR auth)
    echo ""
    echo "Authenticating to public ECR..."
    aws ecr-public get-login-password --region us-east-1 | \
        docker login --username AWS --password-stdin public.ecr.aws

    # Ensure repository exists
    echo ""
    echo "Ensuring repository exists..."
    if aws ecr-public describe-repositories --repository-names "${IMAGE_NAME}" --region us-east-1 >/dev/null 2>&1; then
        echo "Repository '${IMAGE_NAME}' already exists"
    else
        echo "Creating repository '${IMAGE_NAME}'..."
        aws ecr-public create-repository \
            --repository-name "${IMAGE_NAME}" \
            --region us-east-1 \
            --catalog-data "description=Langfuse v3 with custom base path (${BASE_PATH})" || {
            echo "Note: Repository creation failed. Ensure you have ecr-public:CreateRepository permission."
            exit 1
        }
    fi

    # Tag and push
    echo ""
    echo "Tagging and pushing..."
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${FULL_URI}:${IMAGE_TAG}"
    docker tag "${IMAGE_NAME}:${IMAGE_TAG}" "${FULL_URI}:latest"
    docker push "${FULL_URI}:${IMAGE_TAG}"
    docker push "${FULL_URI}:latest"

    echo ""
    echo "========================================="
    echo "Push completed!"
    echo "========================================="
    echo ""
    echo "Web image:    ${FULL_URI}:${IMAGE_TAG}"
    echo "Worker image: ${WORKER_IMAGE} (official, no custom build needed)"
    echo ""
    echo "Helm/OAM values to set:"
    echo "  image.repository: ${FULL_URI}"
    echo "  image.tag: ${IMAGE_TAG}"
    echo "  env NEXT_PUBLIC_BASE_PATH: ${BASE_PATH}"
    echo "  env NEXTAUTH_URL: https://<domain>${BASE_PATH}/api/auth"
    echo ""
    echo "Langfuse ingress path: ${BASE_PATH}"
    echo "Liveness/readiness probe: ${BASE_PATH}/api/public/health"
    echo "========================================="

    # Cleanup
    rm -rf "${BUILD_DIR}"
    exit 0
fi

# ── Usage ────────────────────────────────────────────────────────────────────
echo ""
echo "========================================="
echo "Next steps:"
echo "========================================="
echo ""
echo "To push to public ECR:"
echo "  ./build-langfuse3.sh push"
echo ""
echo "To customize:"
echo "  LANGFUSE_VERSION=v3.201.1 BASE_PATH=/langfuse ./build-langfuse3.sh push"
echo ""
echo "========================================="

# Cleanup
rm -rf "${BUILD_DIR}"
