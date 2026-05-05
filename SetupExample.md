# Setup Example: BridgeRunners Challenge in Dev

This document is a concrete setup flow for wiring one dev challenge to `marathon-match-api-v6`, using this example tester:

`./examples/BridgeRunnersTester.java`

## 1. Prerequisites

- `marathon-match-api-v6` is deployed in dev with ECS env vars configured:
  - `ECS_CLUSTER`
  - `ECS_SUBNETS`
  - `ECS_SECURITY_GROUPS`
  - `ECS_CONTAINER_NAME`
  - `AWS_REGION`
  - `MARATHON_MATCH_API_URL`
  - `REVIEW_API_URL`
  - `REVIEW_TYPE_ID`
- ECS task definition revision for runner is registered and points at your ECR image (see `ecs-runner/README.md`).
- The `marathon-match-api-v6` runtime image includes Java + Maven (`mvn`) for tester compilation jobs.
- You have an admin or M2M token with these scopes:
  - `all:marathon-match` (or `create:marathon-match`, `read:marathon-match`, `update:marathon-match`)
  - `all:marathon-match-tester` (or `create:marathon-match-tester`, `read:marathon-match-tester`, `update:marathon-match-tester`)
  - challenge creation scopes in challenge-api-v6 (`all:challenges` or equivalent create/read/update challenge scopes)

For local smoke tests without Kafka/pg-boss dependencies:

```bash
export DISABLE_KAFKA=true
export DISABLE_PG_BOSS=true
export MVN_BINARY="/path/to/mvn"   # required if `mvn` is not on PATH
export COMPILATION_TMP_DIR="/app/tmp"  # optional; must be writable and executable (not mounted with `noexec`)
```

If this service is being killed with exit code `137` in dev, cap compile-worker memory/concurrency:

```bash
export COMPILE_JAVA_MAX_HEAP_MB=256
export COMPILE_MAVEN_OPTS="-Xms128m -Xmx256m"
export PG_BOSS_COMPILE_TEAM_SIZE=1
export PG_BOSS_COMPILE_TEAM_CONCURRENCY=1
```

## 2. Prepare a BridgeRunners Tester

The baseline MM-164 `BridgeRunnersTester.java` can be used as a standard Topcoder Marathon tester.
The ECS runner now provides the generic submission source discovery, compilation, seed execution, artifact output, and aggregate score payload.

Before creating the tester record:

1. Use `./examples/BridgeRunnersTester.java` as your initial tester source.
2. Make sure `className` in API payload matches the Java class exactly.
   - The baseline file has no `package` declaration, so class name is `BridgeRunnersTester`.

Custom tester-level `runTester(String, com.topcoder.scorer.models.ScorerConfig)` methods are still supported for special-case scorers, but they are no longer required for normal Marathon Match testers.

## 3. Create the Tester Record

Set common variables:

```bash
export MM_API_BASE="https://api.topcoder-dev.com/v6/marathon-match"
export TOKEN="<admin-or-m2m-bearer-token>"
export TESTER_SOURCE_FILE="./examples/BridgeRunnersTester.java"
```

Create tester:

```bash
jq -n \
  --arg name "BridgeRunners MM164 Dev Tester" \
  --arg version "1.0.0-dev1" \
  --arg className "BridgeRunnersTester" \
  --rawfile sourceCode "$TESTER_SOURCE_FILE" \
  '{
    name: $name,
    version: $version,
    className: $className,
    sourceCode: $sourceCode
  }' > /tmp/mm-bridge-tester.json

curl -sS -X POST "$MM_API_BASE/testers" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/mm-bridge-tester.json | jq .
```

Capture returned tester id:

```bash
export TESTER_ID="<returned_tester_id>"
```

## 4. Wait for Compilation Success

Compilation is async. Poll until `SUCCESS`:

```bash
while true; do
  STATUS=$(curl -sS "$MM_API_BASE/testers/$TESTER_ID" \
    -H "Authorization: Bearer $TOKEN" | jq -r '.compilationStatus')
  echo "compilationStatus=$STATUS"
  if [ "$STATUS" = "SUCCESS" ]; then
    break
  fi
  if [ "$STATUS" = "FAILED" ]; then
    curl -sS "$MM_API_BASE/testers/$TESTER_ID" \
      -H "Authorization: Bearer $TOKEN" | jq -r '.compilationError'
    exit 1
  fi
  sleep 5
done
```

## 5. Resolve Challenge Phase IDs

Get phase ids from challenge API response immediately before creating config:

```bash
export CHALLENGE_ID="<dev_challenge_id>"
export CHALLENGE_API_BASE="https://api.topcoder-dev.com/v6"

curl -sS "$CHALLENGE_API_BASE/challenges/$CHALLENGE_ID" \
  -H "Authorization: Bearer $TOKEN" | jq '
    (.result.content.phases // .result.phases // .phases // [])
    | map({
        id: (.phaseId // .id),
        name: (.name // .phaseName // .type // "unknown"),
        isOpen: .isOpen
      })
  '
```

Pick three phase ids to map into:

- `EXAMPLE` config
- `PROVISIONAL` config
- `SYSTEM` config

Note: phase IDs can change if challenge timelines/phases are recalculated. Always map by phase name from the latest challenge response.

## 6. Create Challenge Config

Set config values:

```bash
export REVIEW_SCORECARD_ID="<scorecard_id>"
export TASK_DEFINITION_NAME="mm-ecs-runner"
export TASK_DEFINITION_VERSION="<task_def_revision>"

export EXAMPLE_PHASE_ID="<example_phase_id>"
export PROVISIONAL_PHASE_ID="<provisional_phase_id>"
export SYSTEM_PHASE_ID="<system_phase_id>"
```

`REVIEW_SCORECARD_ID` accepts either the review-api scorecard id or legacy id.

Create config (start with `active: false` until you are ready to process submissions):

```bash
jq -n \
  --arg testerId "$TESTER_ID" \
  --arg reviewScorecardId "$REVIEW_SCORECARD_ID" \
  --arg taskDefinitionName "$TASK_DEFINITION_NAME" \
  --arg taskDefinitionVersion "$TASK_DEFINITION_VERSION" \
  --arg examplePhaseId "$EXAMPLE_PHASE_ID" \
  --arg provisionalPhaseId "$PROVISIONAL_PHASE_ID" \
  --arg systemPhaseId "$SYSTEM_PHASE_ID" \
  '{
    name: "BridgeRunners Dev Config",
    active: false,
    relativeScoringEnabled: true,
    scoreDirection: "MAXIMIZE",
    submissionApiUrl: "https://api.topcoder-dev.com/v6",
    reviewScorecardId: $reviewScorecardId,
    testerId: $testerId,
    testTimeout: 10000,
    compileTimeout: 30000,
    taskDefinitionName: $taskDefinitionName,
    taskDefinitionVersion: $taskDefinitionVersion,
    example: {
      configType: "EXAMPLE",
      phaseId: $examplePhaseId,
      startSeed: 1,
      numberOfTests: 10
    },
    provisional: {
      configType: "PROVISIONAL",
      phaseId: $provisionalPhaseId,
      startSeed: 753376358,
      numberOfTests: 20
    },
    system: {
      configType: "SYSTEM",
      phaseId: $systemPhaseId,
      startSeed: 1651246628,
      numberOfTests: 50
    }
  }' > /tmp/mm-bridge-config.json

curl -sS -X POST "$MM_API_BASE/challenge/$CHALLENGE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  --data @/tmp/mm-bridge-config.json | jq .
```

## 7. Activate and Trigger a Test Run

Activate config:

```bash
curl -sS -X PUT "$MM_API_BASE/challenge/$CHALLENGE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active":true}' | jq .
```

Trigger options:

- Preferred: submit a real test submission in that challenge so normal eventing emits `marathonmatch.submission.received`.
- Manual (if you can publish to Kafka):

```bash
export SUBMISSION_ID="<submission_id_for_challenge>"
export KAFKA_BROKERS="<broker1:9092,broker2:9092>"

echo "{\"mime-type\":\"application/json\",\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\",\"topic\":\"marathonmatch.submission.received\",\"originator\":\"manual-test\",\"payload\":{\"submissionId\":\"$SUBMISSION_ID\",\"challengeId\":\"$CHALLENGE_ID\",\"submissionUrl\":\"\",\"memberHandle\":\"dev-user\",\"memberId\":\"123456\",\"submittedDate\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}}" \
  | kcat -P -b "$KAFKA_BROKERS" -t marathonmatch.submission.received
```

## 8. Verify End-to-End

1. API config + jar:
   - `GET /v6/marathon-match/challenge/:challengeId`
   - `GET /v6/marathon-match/challenge/:challengeId/tester-jar`
2. ECS task launch:
   - `aws ecs list-tasks --cluster "$ECS_CLUSTER" --family "$TASK_DEFINITION_NAME"`
   - `aws ecs describe-tasks --cluster "$ECS_CLUSTER" --tasks <task_arn>`
3. Marathon-match API logs should show:
   - submission event consumed,
   - phase mapping found,
   - ECS task ARN logged,
   - `Submission runner log mapping ready` (submissionId + taskArn + logGroup/logStream when available).
4. API log retrieval (new mapping-backed endpoint):
   - `GET /v6/marathon-match/submissions/:submissionId/runner-logs`
   - optional query: `taskArn`, `limit`, `nextToken`, `startFromHead`
5. ECS runner logs should now be highly verbose for the submission:
   - each workflow step,
   - all outbound API calls (URL + status + payload previews),
   - tester execution metadata and individual test scores (`testScores` when provided by tester),
   - artifact upload/callback payload summaries.
6. Review side:
   - verify review/review-summation update on the submission in dev.

## 9. Safe Rollback

If needed, disable processing immediately:

```bash
curl -sS -X PUT "$MM_API_BASE/challenge/$CHALLENGE_ID" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"active":false}' | jq .
```
