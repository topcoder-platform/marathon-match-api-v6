# marathon-match ecs-runner image

This image is the runtime container for marathon match scoring tasks launched by ECS/Fargate.

## What this image includes

- Java 8 runtime (`eclipse-temurin:8-jre-jammy`)
- `mm-ecs-runner.jar` built from this folder
- utility packages needed by common tester flows (`bash`, `coreutils`, `zip`, `unzip`)
- C++ toolchain support for tester-side submission compilation (`g++`)
- Python runtime support for tester-side submission execution (`python3`)
- C# (Mono) compiler/runtime support for tester-side submission compilation and execution (`mcs`, `mono`)
- C# (.NET 7) SDK support for tester-side submission compilation (`dotnet publish`)
- non-root runtime user (`runner`)

## Recommended ECR naming and tags

- Repository: `mm-ecs-runner`
- Tags:
  - immutable release tag: git SHA (default behavior in publish script)
  - convenience tag: `latest` (optional, enabled by default)

## Build and push to ECR

Run from this repo root:

```bash
AWS_REGION=us-east-1 \
ECR_REPOSITORY=mm-ecs-runner \
./ecs-runner/scripts/build-and-push-ecr.sh
```

Optional variables:

- `IMAGE_TAG`: override default git-sha tag.
- `AWS_ACCOUNT_ID`: skip STS lookup if account ID is known.
- `PLATFORM`: Docker platform target (default `linux/amd64`).
- `PUSH_LATEST`: set to `false` to skip `:latest`.

The script prints the final pushed image URI(s), which can be referenced directly in an ECS task definition.

## Configure marathon-match-api-v6 to use the image

`marathon-match-api-v6` does not store image URI directly. It launches ECS tasks by
`taskDefinitionName:taskDefinitionVersion`, so you need to publish a new ECS task definition revision that points to your new ECR image.

### 1. Register a new ECS task definition revision with the new image

```bash
export AWS_REGION="us-east-1"
export TASK_FAMILY="mm-ecs-runner"
export CONTAINER_NAME="tc-mm-runner"
export NEW_IMAGE="123456789012.dkr.ecr.us-east-1.amazonaws.com/mm-ecs-runner:<tag>"

aws ecs describe-task-definition \
  --region "$AWS_REGION" \
  --task-definition "$TASK_FAMILY" \
  --query 'taskDefinition' > /tmp/mm-taskdef.json

jq --arg C "$CONTAINER_NAME" --arg I "$NEW_IMAGE" '
  .containerDefinitions |= map(if .name == $C then .image = $I else . end)
  | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy)
' /tmp/mm-taskdef.json > /tmp/mm-taskdef.new.json

NEW_REVISION=$(
  aws ecs register-task-definition \
    --region "$AWS_REGION" \
    --cli-input-json file:///tmp/mm-taskdef.new.json \
    --query 'taskDefinition.revision' \
    --output text
)

echo "Registered: ${TASK_FAMILY}:${NEW_REVISION}"
```

### 2. Ensure marathon-match-api-v6 ECS env vars are set

Set these in the API service environment:

- `ECS_CLUSTER`
- `ECS_SUBNETS`
- `ECS_SECURITY_GROUPS`
- `ECS_CONTAINER_NAME` (must match `CONTAINER_NAME` above)
- `AWS_REGION`
- `MARATHON_MATCH_API_URL`
- `REVIEW_TYPE_ID`
- `DEBUG_LOG_ACCESS_TOKEN` (optional, set `true` to log token preview + decoded JWT header/payload in runner logs)
- `DEBUG_LOG_FULL_ACCESS_TOKEN` (optional, only with `DEBUG_LOG_ACCESS_TOKEN=true`; logs full bearer token)

### 3. Update challenge config to use that task definition revision

```bash
curl -X PUT "https://api.topcoder-dev.com/v6/marathon-match/challenge/<challengeId>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"taskDefinitionName\":\"${TASK_FAMILY}\",\"taskDefinitionVersion\":\"${NEW_REVISION}\"}"
```

Once this is saved and the config is active, new scoring launches use the new ECR image through that ECS task definition revision.

## Local smoke test

```bash
docker build -f ecs-runner/Dockerfile -t mm-ecs-runner:local ecs-runner
docker run --rm mm-ecs-runner:local
```

The container exits quickly unless all required scorer environment variables are provided.
