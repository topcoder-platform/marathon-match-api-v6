# ECS Runner Lifetime

This document describes how `marathon-match-api-v6` starts ECS scorer runners, how to monitor them while they are active, and how to stop them when the work is no longer needed.

The runner task is the `ecs-runner` Fargate container built from `ecs-runner/Dockerfile`. The API never launches an image directly; it launches the configured ECS task definition revision from each Marathon Match config.

## Required launch configuration

Before any runner can start, the API service needs these ECS/runtime values:

- `ECS_CLUSTER`
- `ECS_SUBNETS`
- `ECS_SECURITY_GROUPS`
- `ECS_CONTAINER_NAME`
- `AWS_REGION` (defaults to `us-east-1`)
- `MARATHON_MATCH_API_URL`
- `REVIEW_API_URL`
- `REVIEW_TYPE_ID`
- Auth0 M2M settings used by the API and forwarded to the trusted parent runner for long-running token refresh

Each active challenge config also needs:

- `active: true`
- compiled tester with `compilationStatus = SUCCESS`
- `taskDefinitionName`
- `taskDefinitionVersion`
- phase configs for `EXAMPLE`, `PROVISIONAL`, and/or `SYSTEM`

## Start paths

All start paths converge on `EcsService.launchScorerTask(...)`.

### Live submission scoring

1. A `marathonmatch.submission.received` Kafka message arrives with `challengeId`, `submissionId`, and usually `memberId`.
2. `MarathonMatchSubmissionHandler` loads the challenge's Marathon Match config.
3. The handler skips the submission if the config is inactive, the challenge has no open phase, or no stored phase config matches the open challenge phase.
4. For every matching phase config, the handler calls `EcsService.launchScorerTask(...)`.

This is the normal path for `EXAMPLE` and `PROVISIONAL` scoring during the Submission phase. If both phase configs map to the same open challenge phase, the API intentionally launches one runner per matching config.  This is to handle the case where we want example _and_ provisional tests to run during the submission phase in most cases.

### Validation submission scoring

`POST /v6/marathon-match/challenge/:challengeId/test-submission` uploads a validation submission through the configured Submission API and then launches one ECS runner for the requested `configType` (default `PROVISIONAL`). The response includes `submissionId`, `taskArn`, `taskId`, and usually `cloudWatchLogsConsoleUrl`.

We do this to support admins / copilots having the ability to test the scorer before the challenge launches.

### Manual latest-submission rerun

`POST /v6/marathon-match/challenge/:challengeId/rerun` finds the latest submission per member and launches scorer tasks for the phase config that matches the currently open challenge phase. Use this after changing tester configuration or when current latest submissions need to be recalculated.

### SYSTEM review scoring

SYSTEM scoring starts from review orchestration:

1. Autopilot creates or finds a pending Review API review for a latest submission.
2. Autopilot calls `POST /v6/marathon-match/internal/system-score` with `reviewId`, `submissionId`, and `challengeId`.
3. `ScoringResultService.triggerSystemScore(...)` loads the config, launches the SYSTEM runner, and schedules a pg-boss timeout guard using `systemTestTimeout`.

`POST /v6/marathon-match/challenge/:challengeId/rerun/system` restarts existing non-cancelled SYSTEM review records through the same SYSTEM launch path.

## What launch does

ECS Service:

https://github.com/topcoder-platform/marathon-match-api-v6/blob/955671e28e0d96fc871e2af060cf7d694a8a9475/src/shared/modules/global/ecs.service.ts#L85-L86

`EcsService.launchScorerTask(...)` performs these steps before and during `RunTask`:

1. Reads the configured ECS cluster, container name, network settings, API URL, review type, task definition family, and revision.
2. Lists active `PENDING` and `RUNNING` tasks for the task family, then describes them and inspects container override environment values.
3. Stops older active tasks for the same `challengeId` and `memberId` when a newer submission for that member is being launched.
4. Reuses an existing active task instead of launching a duplicate for the same challenge, submission, and phase config type.
5. Enforces `ECS_SCORER_MAX_CONCURRENT_TASKS` before creating more work. The default cap is `20`.
6. Fetches an M2M token and injects runner environment variables into the configured ECS container.
7. Calls ECS `RunTask` with `launchType: FARGATE`, `awsvpc` networking, and `assignPublicIp: DISABLED`.
8. Resolves the task definition's `awslogs-group` and `awslogs-stream-prefix`, then builds the deterministic stream name as `<prefix>/<containerName>/<taskId>`.
9. Logs and persists a `submissionRunnerLog` mapping with the submission, task, cluster, container, task definition, CloudWatch log metadata, and phase config type.

The runner receives these main environment values:

- `TESTER_CONFIG_ID`
- `SUBMISSION_ID`
- `ACCESS_TOKEN`
- `MARATHON_MATCH_API_URL`
- `REVIEW_TYPE_ID`
- `TEST_PHASE`
- `PHASE_CONFIG_TYPE`
- `PHASE_START_SEED`
- `PHASE_NUMBER_OF_TESTS`
- `REVIEW_ID` for SYSTEM scoring
- `MEMBER_ID` when known

## Runner execution

Inside the task, the trusted Java parent runner:

1. Fetches the challenge config, tester JAR, and tester metadata from `marathon-match-api-v6`.
2. Downloads the submission from the configured Submission API URL.
3. Posts an initial progress callback for `PROVISIONAL` and `SYSTEM` runs.
4. Starts the tester in an isolated child JVM. Submitted solution commands run as the separate `scorer` user with scrubbed environment, restricted filesystem access, and no outbound INET/INET6 socket creation.
5. Uploads public/private artifacts back through Submission API.
6. Posts the final scoring callback to `POST /v6/marathon-match/internal/scoring-results`.
7. Exits with code `0` only after the final callback succeeds.

On failure, the runner writes failure artifacts, uploads them when possible, posts best-effort failed progress for tracked phases, logs `runner.failure`, and exits non-zero.

## Monitoring

### Launch mapping

Every launch logs `Launched ECS scorer task` and `Submission to ECS runner log mapping`. The mapping is also stored in `marathon_match.submissionRunnerLog`.

The mapping contains:

- `submissionId`
- `challengeId`
- `taskArn`
- `taskId`
- `cluster`
- `containerName`
- `taskDefinition`
- `phaseConfigType`
- `logGroup`
- `logStreamName`
- `cloudWatchLogsConsoleUrl`

### Runner logs endpoint

Use the API endpoint when you have a submission ID:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$MARATHON_MATCH_API_URL/submissions/$SUBMISSION_ID/runner-logs"
```

Add `taskArn` when a submission has multiple runner launches:

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$MARATHON_MATCH_API_URL/submissions/$SUBMISSION_ID/runner-logs?taskArn=$TASK_ARN&limit=200"
```

The endpoint returns all known mappings for the submission, the selected mapping, CloudWatch log events, and CloudWatch pagination tokens.

### CloudWatch logs

If you have `logGroup` and `logStreamName` from the mapping:

```bash
aws logs tail "$LOG_GROUP" \
  --region "$AWS_REGION" \
  --log-stream-names "$LOG_STREAM_NAME" \
  --follow
```

Useful runner log markers include:

- `bootstrap`
- `api.fetch-config`
- `api.fetch-tester-jar`
- `api.download-submission`
- `tester.isolated`
- `tester.invoke`
- `api.progress`
- `artifacts.upload`
- `api.callback`
- `runner.failure`
- `cleanup`
- `exit`

Success usually includes `Scoring callback completed successfully`, a runner result payload, and `Exiting runner with code 0`.

### ECS task status

Use ECS when you need runtime/container status:

```bash
aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].{lastStatus:lastStatus,desiredStatus:desiredStatus,stoppedReason:stoppedReason,containers:containers[*].{name:name,lastStatus:lastStatus,exitCode:exitCode,reason:reason}}'
```

`lastStatus = STOPPED` means ECS considers the task terminal. Check the container `exitCode` and `reason` to distinguish normal completion from runner failures, OOM stops, or manual stops.

### Review progress metadata

For `PROVISIONAL` and `SYSTEM`, the runner posts progress to `POST /v6/marathon-match/internal/scoring-progress`. Review summation metadata is updated with:

- `testProcess`: `provisional` or `system`
- `testProgress`: value from `0` to `1`
- `testStatus`: `IN PROGRESS`, `SUCCESS`, or `FAILED`
- `timed_out: true` for SYSTEM timeout failures

Treat `IN PROGRESS` summations as unavailable, even when they carry a placeholder score.

## Stopping or killing runners

### Stop new work first

To stop future Marathon Match launches for a challenge, set the config inactive:

```bash
curl -X PUT "$MARATHON_MATCH_API_URL/challenge/$CHALLENGE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active":false}'
```

This prevents new scoring dispatch for that config. It does not stop tasks that are already running.

### Stop one active ECS task

There is no public HTTP endpoint that wraps `EcsService.stopTask(...)`. For an operator-initiated kill, use ECS directly with the task ARN from the runner mapping:

```bash
aws ecs stop-task \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --task "$TASK_ARN" \
  --reason "Marathon Match runner no longer needed"
```

Then verify the task reached `STOPPED`:

```bash
aws ecs describe-tasks \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --tasks "$TASK_ARN" \
  --query 'tasks[0].{lastStatus:lastStatus,desiredStatus:desiredStatus,stoppedReason:stoppedReason,containers:containers[*].{name:name,exitCode:exitCode,reason:reason}}'
```

Manual ECS stops can interrupt the Java process before it posts final scoring results. After a manual stop, check Review summation metadata and decide whether to rerun, leave the result unavailable, or apply an operator-side failure workflow.

### Automatic same-member cancellation

For submission-phase launches that include `memberId`, the API stops older active scorer tasks for the same challenge/member before launching the newer submission. The ECS stop reason is:

`Superseded by newer Marathon Match submission <submissionId> for challenge <challengeId>.`

This is the normal cleanup path for obsolete in-flight work when a competitor submits again.

### SYSTEM timeout stop

Every SYSTEM launch schedules a `system-test-timeout` pg-boss job unless `DISABLE_PG_BOSS=true` or timeout scheduling is unavailable. The timeout uses `systemTestTimeout` from the challenge config and defaults to 24 hours.

When the timeout job runs, it:

1. Describes the ECS task.
2. Skips work if the task is already stopped.
3. Checks whether SYSTEM scoring is already complete.
4. Calls `EcsService.stopTask(...)` if the task is still active and scoring is incomplete.
5. Writes a failed SYSTEM result with score `-1` and metadata containing `timed_out: true`, `timeoutMs`, `taskArn`, and a timeout message.

### Stop all active tasks for a task family

Use this only after confirming the task family is dedicated to Marathon Match scoring in the target environment:

```bash
aws ecs list-tasks \
  --region "$AWS_REGION" \
  --cluster "$ECS_CLUSTER" \
  --family "$TASK_FAMILY" \
  --desired-status RUNNING \
  --query 'taskArns' \
  --output text
```

Stop selected ARNs one by one with `aws ecs stop-task`. Repeat the list command with `--desired-status PENDING` if you also need to cancel queued tasks that have not reached `RUNNING`.

## Practical lifecycle checklist

1. Confirm the challenge config is active, tester compilation succeeded, and task definition values point to the intended ECS revision.
2. Start work through the natural trigger: Kafka submission event, validation upload, rerun endpoint, or SYSTEM scoring endpoint.
3. Capture `taskArn`, `taskId`, `logGroup`, and `logStreamName` from the API response, API logs, or `GET /submissions/:submissionId/runner-logs`.
4. Monitor CloudWatch logs, ECS task status, and Review summation progress metadata.
5. When work is obsolete, deactivate the config if needed, then stop the selected ECS task ARN.
6. After a manual stop, verify ECS `STOPPED` status and clean up the scoring state by rerunning or marking the result through the appropriate operator workflow.
