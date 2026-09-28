# marathon-match ecs-runner image

This image is the runtime container for marathon match scoring tasks launched by ECS/Fargate.

## What this image includes

- Ubuntu OpenJDK 17 JDK/runtime for runner execution and Java submission compilation; Java submissions remain targeted to the Java 11 language/API level with `javac --release 11`
- `mm-ecs-runner.jar` built from this folder
- utility packages needed by common tester flows (`bash`, `coreutils`, `zip`, `unzip`)
- C++23 toolchain support for tester-side submission compilation (`g++` via GCC 14)
- Kotlin/JVM 2.4.10 compiler support for tester-side `.kt` submission compilation (`kotlinc`); the unused main-kts scripting plugin is omitted
- Python 3.12 runtime support for tester-side submission execution (`python3`)
- C# (Mono) compiler/runtime support for tester-side submission compilation and execution (`mcs`, `mono`)
- C# (.NET 7 / C# 11 and .NET 10 / C# 14) support for tester-side submission compilation (`dotnet publish`); the maintained .NET 10 SDK compiles both targets and the image retains only the .NET 7 reference, host, and runtime packs required by `net7.0`
- Rust latest stable compiler support for tester-side submission compilation (`rustc`)
- native `mm-runner-isolate` and `mm-scorer-isolate` helpers that scrub the child JVM environment, run the tester JVM as the non-root `runner` user, run submitted solutions as the separate non-root `scorer` user, restrict submitted-solution filesystem access, block `io_uring`, and block non-`AF_UNIX` sockets for submitted solution processes

## Isolation model

- The container entrypoint runs as non-root uid `10000` (`runner-parent`) with primary group `runner`. Do not override the ECS task-definition `user`; the entrypoint rejects any other uid so an accidental root override cannot weaken the image's default boundary.
- The trusted parent runner performs network bootstrap work: fetch challenge config, download tester/submission artifacts, upload artifacts, and post the scoring callback. Submission downloads authenticate the initial API request, then follow short-lived signed-storage redirects without forwarding the API bearer token across origins.
- The tester executes in a separate child JVM launched through the setuid-root `mm-runner-isolate` bridge as uid/gid `10001` (`runner`) with a scrubbed environment. The bridge forks, drops the child permanently to `runner`, and drops its supervisor back to `runner-parent` with only `CAP_KILL` for timeout forwarding. Distinct parent/tester UIDs prevent the tester from reading trusted parent process state such as `ACCESS_TOKEN` through `/proc`. Both setuid helpers are owned by `root:runner` with mode `4750`, so only the trusted parent and tester accounts can invoke them; the submitted `scorer` account cannot.
- Generic submitted solution commands execute through the setuid-root `mm-scorer-isolate` bridge as uid/gid `10002` (`scorer`). The bridge drops its supervisor back to the invoking `runner` uid after it forks the solution child, retaining only `CAP_KILL` so tester timeouts can still terminate the lower-privilege solution process group.
- Downloaded tester JARs and the serialized scorer-config handoff are parent-owned mode `0440` files in group `runner`. This gives the isolated tester read-only access without exposing either file to `scorer`; the config is created inside the shared workspace and the child JVM deletes it immediately after loading it, before tester or submitted solution code executes.
- Parent-created workspaces use group `runner` with group read/write access. The tester helper applies umask `0007`, so tester-created files remain manageable by the non-root parent without making them accessible to `scorer`.
- Generic Marathon seed execution resets scorer-owned writable state before and after every test case, so files written by one seed are not visible to later seeds in the same submission run. The Java child invokes the setuid `mm-scorer-isolate --cleanup-scorer-state` mode, which accepts no caller-supplied path, scans only fixed writable roots such as `/tmp`, `/var/tmp`, `/dev/shm`, and the scorer home, and removes only entries owned by uid `10002`. Cleanup uses descriptor-relative `openat`, `fstatat`, and `unlinkat` operations with `O_NOFOLLOW`, so swapping an entry for a symlink cannot redirect the privileged traversal.
- Generic submitted solution commands run under a Landlock filesystem allowlist. Runtime and toolchain files are readable, `/proc/self/maps` is readable for glibc/Mono stack introspection, `/tmp` and the scorer home are writable, and infrastructure-revealing paths such as `/etc/hostname`, `/etc/resolv.conf`, `/proc/self/cgroup`, `/proc/self/mounts`, and proc network tables are not readable by submitted code.
- Rust submissions run with `RUST_BACKTRACE=1` so panic stderr captured in `output.txt` includes a backtrace.
- Artifact previews and artifact zip uploads include only non-symlink regular files from the runner artifact directories. Submitted symlinks are ignored instead of being dereferenced by the trusted parent runner.
- Submitted solution processes and their fork/exec children cannot use `io_uring` and can create only `AF_UNIX` sockets. These restrictions are kernel seccomp filters inherited across fork/exec, so clearing `LD_PRELOAD` in a spawned child process does not restore INET or INET6 socket access. Outbound network access from the submission itself is therefore blocked even though the parent runner still has the trusted egress it needs.
- The child JVM runs standard Topcoder Marathon testers through the generic runner flow. Custom tester `runTester(...)` result maps remain supported for advanced cases, but standard testers do not need ECS-specific code.
- Per-seed private `stdout` and `stderr` artifacts are tester-owned with mode `0640`: the shared `runner` group lets the non-root parent read and archive them, while the submitted `scorer` user has no access. Empty output files use the same permissions. Permissions are set on the temporary file before replacing the final seed path, preserving symlink protection.

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

Generic runner member-visible artifacts are uploaded only for EXAMPLE scoring. Their public `output.txt` shows testcase ordinal, actual seed, seed score, runtime, runner/tester errors, and submitted-solution stderr, while intentionally omitting submitted-solution stdout and compilation diagnostics. The separate `compile_log.txt` file preserves compilation output. Every generic scoring phase uploads private internal artifacts in the `*-internal` zip: `reviews.json` carries `compilationOutput`, per-test `metadata.testScores`, and top-level `testScores` with testcase ordinals and actual seeds, `compile_log.txt` and `execution-{submissionId}.log` preserve runner diagnostics, `error-{submissionId}.log` is included when present, and `stdout/{seed}.txt` plus `stderr/{seed}.txt` carry captured submitted-solution output for each actual seed. PROVISIONAL and SYSTEM scoring do not publish competitor-visible artifacts.

## Local smoke test

```bash
docker build -f ecs-runner/Dockerfile -t mm-ecs-runner:local ecs-runner
docker run --rm mm-ecs-runner:local
```

The default process reports uid `10000` and exits quickly unless all required scorer environment variables are provided. `mm-runner-isolate id -u` reports `10001`, while `mm-scorer-isolate id -u` reports `10002`; both helpers discard caller secrets before starting their child commands.

## Local socket-isolation regression

```bash
./ecs-runner/scripts/test-mm-net-isolate-socket-block.sh
```

This compiles the native helper in no-user-drop test mode, runs a Python
`ctypes` raw `socket` syscall probe under seccomp, and verifies that an
`AF_INET` socket is denied while `AF_UNIX` socket pairs still work.
