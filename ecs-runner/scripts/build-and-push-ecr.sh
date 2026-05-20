#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${RUNNER_DIR}/.." && pwd)"

AWS_REGION="${AWS_REGION:-us-east-1}"
ECR_REPOSITORY="${ECR_REPOSITORY:-mm-ecs-runner}"
IMAGE_TAG="${IMAGE_TAG:-$(git -C "${REPO_ROOT}" rev-parse --short HEAD)}"
PLATFORM="${PLATFORM:-linux/amd64}"
PUSH_LATEST="${PUSH_LATEST:-true}"

if ! command -v aws >/dev/null 2>&1; then
  echo "aws CLI is required but not installed."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker is required but not installed."
  exit 1
fi

if [[ -z "${AWS_ACCOUNT_ID:-}" ]]; then
  AWS_ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
fi

if [[ -z "${AWS_ACCOUNT_ID}" || "${AWS_ACCOUNT_ID}" == "None" ]]; then
  echo "Unable to resolve AWS account ID. Set AWS_ACCOUNT_ID and try again."
  exit 1
fi

IMAGE_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPOSITORY}"

aws ecr describe-repositories --region "${AWS_REGION}" --repository-names "${ECR_REPOSITORY}" >/dev/null 2>&1 || \
  aws ecr create-repository --region "${AWS_REGION}" --repository-name "${ECR_REPOSITORY}" >/dev/null

aws ecr get-login-password --region "${AWS_REGION}" | \
  docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

TAG_ARGS=(-t "${IMAGE_URI}:${IMAGE_TAG}")
if [[ "${PUSH_LATEST}" == "true" ]]; then
  TAG_ARGS+=(-t "${IMAGE_URI}:latest")
fi

docker buildx build \
  --platform "${PLATFORM}" \
  -f "${RUNNER_DIR}/Dockerfile" \
  "${TAG_ARGS[@]}" \
  --push \
  "${RUNNER_DIR}"

echo "Pushed image: ${IMAGE_URI}:${IMAGE_TAG}"
if [[ "${PUSH_LATEST}" == "true" ]]; then
  echo "Pushed image: ${IMAGE_URI}:latest"
fi
