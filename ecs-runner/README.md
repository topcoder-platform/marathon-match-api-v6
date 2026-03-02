# marathon-match ecs-runner image

This image is the runtime container for marathon match scoring tasks launched by ECS/Fargate.

## What this image includes

- Java 8 runtime (`eclipse-temurin:8-jre-jammy`)
- `mm-ecs-runner.jar` built from this folder
- utility packages needed by common tester flows (`bash`, `coreutils`, `zip`, `unzip`)
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

## Local smoke test

```bash
docker build -f ecs-runner/Dockerfile -t mm-ecs-runner:local ecs-runner
docker run --rm mm-ecs-runner:local
```

The container exits quickly unless all required scorer environment variables are provided.
