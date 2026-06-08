# marathon-match ecs-runner image

This image is the runtime container for marathon match scoring tasks launched by ECS/Fargate.

## What this image includes

- Java 11 JDK/runtime (`eclipse-temurin:11-jdk-noble`) for runner execution and Java submission compilation (`javac --release 11`, `java`)
- `mm-ecs-runner.jar` built from this folder
- utility packages needed by common tester flows (`bash`, `coreutils`, `zip`, `unzip`)
- C++23 toolchain support for tester-side submission compilation (`g++` via GCC 14)
- Python 3.12 runtime support for tester-side submission execution (`python3`)
- C# (Mono) compiler/runtime support for tester-side submission compilation and execution (`mcs`, `mono`)
- C# (.NET 7 / C# 11 and .NET 10 / C# 14) SDK support for tester-side submission compilation (`dotnet publish`)
- Rust latest stable compiler support for tester-side submission compilation (`rustc`)
- native `mm-runner-isolate` and `mm-scorer-isolate` helpers that scrub the child JVM environment, run the tester JVM as the non-root `runner` user, run submitted solutions as the separate non-root `scorer` user, block `io_uring`, and block non-`AF_UNIX` sockets for submitted solution processes

## Isolation model

- The container entrypoint starts as `root`. Do not override the ECS task-definition `user` for this container; root is needed for trusted bootstrap work and for preparing runner-owned files before the child JVM starts.
- The trusted parent runner performs network bootstrap work: fetch challenge config, download tester/submission artifacts, upload artifacts, and post the scoring callback.
- The tester executes in a separate child JVM launched through `mm-runner-isolate` as uid/gid `10001` (`runner`) with a scrubbed environment, so `ACCESS_TOKEN` and other runner env vars are not inherited by untrusted code.
- Generic submitted solution commands execute through the setuid-root `mm-scorer-isolate` bridge as uid/gid `10002` (`scorer`). The bridge drops its supervisor back to the invoking `runner` uid after it forks the solution child, then supervises the solution process group so tester timeouts can still terminate lower-privilege processes.
- Downloaded tester JARs and serialized scorer config are mode `0400` runner-owned files. Submitted code running as `scorer` cannot read or modify them even if it can guess their `/tmp` paths.
- Artifact previews and artifact zip uploads include only non-symlink regular files from the runner artifact directories. Submitted symlinks are ignored instead of being dereferenced by the trusted parent runner.
- Submitted solution processes and their fork/exec children cannot use `io_uring` and can create only `AF_UNIX` sockets. These restrictions are kernel seccomp filters inherited across fork/exec, so clearing `LD_PRELOAD` in a spawned child process does not restore INET or INET6 socket access. Outbound network access from the submission itself is therefore blocked even though the parent runner still has the trusted egress it needs.
- The child JVM runs standard Topcoder Marathon testers through the generic runner flow. Custom tester `runTester(...)` result maps remain supported for advanced cases, but standard testers do not need ECS-specific code.

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
- `MM_RUNNER_MAX_OUTPUT_BYTES` (optional, defaults to `10000000`; caps runner output and artifact archives before upload)
- `AUTH0_URL`
- `AUTH0_AUDIENCE`
- `AUTH0_CLIENT_ID`
- `AUTH0_CLIENT_SECRET`
- `AUTH0_PROXY_SERVER_URL` (optional)
- `DEBUG_LOG_ACCESS_TOKEN` (optional, set `true` to log only redacted token presence/length in runner logs)

Long-running SYSTEM scorer tasks refresh their parent-runner M2M bearer token before expiry and retry once with a fresh token after an API `401`. The API injects the launch token plus the Auth0 settings above into the trusted parent runner. The isolated child JVM and submitted solution processes still receive a scrubbed environment and do not inherit `ACCESS_TOKEN`, `AUTH0_CLIENT_SECRET`, or other runner env vars.

Keep `ECS_SECURITY_GROUPS` least-privilege. The scorer helper blocks untrusted submission egress, but the parent runner still needs trusted access to Marathon Match API and Submission API endpoints.

When submissions are launched, API logs now emit a `Submission to ECS runner log mapping` record that includes:

- `submissionId`
- `taskArn`
- `taskId`
- `cluster`
- `containerName`
- `logGroup` (resolved from ECS task definition `awslogs-group`)
- `logStreamPrefix` (resolved from ECS task definition `awslogs-stream-prefix`)
- `logStreamName` (deterministic value `<prefix>/<containerName>/<taskId>`)
- `cloudWatchLogsConsoleUrl` (when both log group + stream are available)

The same mapping is also persisted in `marathon_match.submissionRunnerLog`, and can be queried via:

- `GET /v6/marathon-match/submissions/:submissionId/runner-logs`

### 3. Update challenge config to use that task definition revision

```bash
curl -X PUT "https://api.topcoder-dev.com/v6/marathon-match/challenge/<challengeId>" \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d "{\"taskDefinitionName\":\"${TASK_FAMILY}\",\"taskDefinitionVersion\":\"${NEW_REVISION}\"}"
```

Once this is saved and the config is active, new scoring launches use the new ECR image through that ECS task definition revision.

## Output and artifact size limit

The runner rejects output once generated public `output.txt` content or a public/private artifact archive would exceed `MM_RUNNER_MAX_OUTPUT_BYTES`. The default is `10000000` bytes. The trusted parent runner passes the resolved limit into the isolated tester child, so generated generic-runner output and uploaded artifact zips use the same cap.

## Local smoke test

```bash
docker build -f ecs-runner/Dockerfile -t mm-ecs-runner:local ecs-runner
docker run --rm mm-ecs-runner:local
```

The container exits quickly unless all required scorer environment variables are provided.

## Local socket-isolation regression

```bash
./ecs-runner/scripts/test-mm-net-isolate-socket-block.sh
```

This compiles the native helper in no-user-drop test mode, runs a Python
`ctypes` raw `socket` syscall probe under seccomp, and verifies that an
`AF_INET` socket is denied while `AF_UNIX` socket pairs still work.
