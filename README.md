# marathon-match-api-v6

NestJS service for managing marathon match scorer configuration, compiling tester JARs, consuming submission events from Kafka, and launching ECS scoring tasks.

## Service base path

All HTTP endpoints are exposed under:

`/v6/marathon-match`

Swagger UI:

`/v6/marathon-match/api-docs`

## Configuration values

The service is configured via environment variables.

### Core service and database

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `PORT` | No | `3000` | HTTP listen port |
| `NODE_ENV` | No | (unset) | Token-expiration behavior and Prisma logging behavior |
| `CORS_ALLOWED_ORIGIN` | No | Built-in localhost/topcoder regex list | CORS origin matching |
| `DATABASE_URL` | Yes | None | Prisma + pg-boss Postgres connection |
| `POSTGRES_SCHEMA` | No | `public` | Prisma schema name used in runtime logging/connection context |
| `MM_SERVICE_PRISMA_TIMEOUT` | No | `10000` | Prisma transaction timeout (ms) |

### JWT auth and M2M auth

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `AUTH_SECRET` | Yes (for JWT validation) | None | tc-core JWT authenticator secret |
| `VALID_ISSUERS` | No | Topcoder/Auth0 issuer JSON array string | Accepted JWT issuers |
| `AUTH0_ISSUER` | No | `https://topcoder-dev.auth0.com/` | Legacy JWT config field |
| `TOKEN_AUDIENCE` | No | `https://m2m.topcoder-dev.com/` | Legacy JWT config field |
| `AUTH0_URL` | No | `http://localhost:4000/oauth/token` | M2M token endpoint |
| `AUTH0_DOMAIN` | No | `topcoder-dev.auth0.com` | M2M config metadata |
| `AUTH0_AUDIENCE` | No | `https://m2m.topcoder-dev.com/` | M2M audience |
| `AUTH0_PROXY_SERVER_URL` | No | (unset) | Optional M2M proxy |
| `AUTH0_CLIENT_ID` | Yes (for outbound API calls) | None | M2M client ID |
| `AUTH0_CLIENT_SECRET` | Yes (for outbound API calls) | None | M2M client secret |

### Kafka consumer/producer

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `DISABLE_KAFKA` | No | `false` | Fully disable Kafka connection/consumption |
| `KAFKA_URL` | No | `localhost:9092` | Broker list (comma-separated). If unset, `KAFKA_BROKERS` is also accepted |
| `KAFKA_BROKERS` | No | (fallback only) | Alternative broker list env key (review-api compatibility) |
| `KAFKA_CLIENT_ID` | No | `tc-marathon-match-api` | Kafka client ID |
| `KAFKA_GROUP_ID` | No | `tc-marathon-match-consumer-group` | Consumer group ID |
| `KAFKA_SSL_ENABLED` | No | `false` | Enable TLS |
| `KAFKA_SASL_MECHANISM` | No | `plain` | SASL mechanism (`plain`, `scram-sha-256`, `scram-sha-512`) |
| `KAFKA_SASL_USERNAME` | No | (unset) | SASL username (enables SASL when set) |
| `KAFKA_SASL_PASSWORD` | No | empty string | SASL password |
| `KAFKA_CONNECTION_TIMEOUT` | No | `10000` | Kafka connect timeout (ms) |
| `KAFKA_REQUEST_TIMEOUT` | No | `30000` | Kafka request timeout (ms) |
| `KAFKA_MAXBYTES` / `KAFKA_MAX_BYTES` | No | Kafka client default | Consumer fetch max bytes (dev parity with review-api usage) |
| `KAFKA_MIN_BYTES` | No | Kafka client default | Consumer fetch minimum bytes |
| `KAFKA_MAX_WAIT_TIME` | No | Auto-derived from request timeout | Consumer fetch max wait (ms) |
| `KAFKA_RETRY_ATTEMPTS` | No | `5` | Client reconnection retry count |
| `KAFKA_INITIAL_RETRY_TIME` | No | `100` | Initial retry delay (ms) |
| `KAFKA_MAX_RETRY_TIME` | No | `30000` | Max exponential retry delay (ms) |
| `KAFKA_DLQ_ENABLED` | No | `false` | Enable DLQ publishing after retry exhaustion |
| `KAFKA_DLQ_TOPIC_SUFFIX` | No | `.dlq` | DLQ topic suffix |
| `KAFKA_DLQ_MAX_RETRIES` | No | `3` | Per-message retries before DLQ |

### Marathon scoring integration

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `CHALLENGE_API_URL` | No | `https://api.topcoder-dev.com` | Challenge API lookup for current active phase |
| `DISABLE_PG_BOSS` | No | `false` | Disable pg-boss queue/worker and run tester compilation inline |
| `COMPILE_TIMEOUT_MS` | No | `120000` | Maven tester compilation timeout |
| `COMPILE_JAVA_MAX_HEAP_MB` | No | `384` | Max JVM heap (MB) enforced for tester compilation Maven process when `-Xmx` is not already provided |
| `COMPILE_MAVEN_OPTS` | No | (auto-derived) | Compile-worker specific `MAVEN_OPTS`; if unset, falls back to `MAVEN_OPTS` and auto-appends `-Xmx` cap |
| `MVN_BINARY` | No | `mvn` | Maven executable for tester compilation |
| `BOILERPLATE_DIR` | No | `<repo>/ecs-runner/boilerplate` | Java boilerplate project copied for compilation |
| `COMPILATION_TMP_DIR` | No | Auto-discovery (`TMPDIR`, `/dev/shm` on Linux, `os.tmpdir()`, `<repo>/tmp`) | Writable temp root used for compile workspaces; set to `/dev/shm` to keep workspace on memory-backed tmpfs |
| `PG_BOSS_COMPILE_TEAM_SIZE` | No | `1` | Number of pg-boss compile workers processing jobs in parallel |
| `PG_BOSS_COMPILE_TEAM_CONCURRENCY` | No | `1` | Per-worker concurrency for compile jobs |

### ECS launch configuration

| Variable | Required | Default | Used for |
| --- | --- | --- | --- |
| `AWS_REGION` | No | `us-east-1` | AWS SDK ECS client region |
| `ECS_CLUSTER` | Yes (for scoring) | None | ECS cluster for `RunTask` |
| `ECS_SUBNETS` | Yes (for scoring) | None | Comma-separated subnets for awsvpc task networking |
| `ECS_SECURITY_GROUPS` | Yes (for scoring) | None | Comma-separated security groups for awsvpc networking |
| `ECS_CONTAINER_NAME` | Yes (for scoring) | None | Container override target in task definition |
| `MARATHON_MATCH_API_URL` | Yes (for scoring) | None | Base URL passed to ECS runner |
| `REVIEW_API_URL` | Yes (for scoring) | None | Review API base URL used by NestJS scoring callback processor |
| `REVIEW_TYPE_ID` | Yes (for scoring) | None | Review type ID passed to ECS runner callback payload |

### ECS runner task environment (injected at launch)

These are required by `ecs-runner` and are passed in container overrides when a task is launched:

- `TESTER_CONFIG_ID`
- `SUBMISSION_ID`
- `ACCESS_TOKEN`
- `MARATHON_MATCH_API_URL`
- `REVIEW_TYPE_ID`
- `TEST_PHASE`
- `PHASE_CONFIG_TYPE`
- `PHASE_START_SEED`
- `PHASE_NUMBER_OF_TESTS`

## Exit code 137 (OOM) mitigation

`137` usually means the process was killed by the container runtime due to memory pressure.
For development environments with tight memory limits, use these settings first:

```bash
COMPILE_JAVA_MAX_HEAP_MB=256
COMPILE_MAVEN_OPTS="-Xms128m -Xmx256m"
PG_BOSS_COMPILE_TEAM_SIZE=1
PG_BOSS_COMPILE_TEAM_CONCURRENCY=1
```

If you are not actively consuming submission events or async compile queues in a dev smoke test, also disable background workers:

```bash
DISABLE_KAFKA=true
DISABLE_PG_BOSS=true
```

## Endpoints and auth

All secured endpoints require `Authorization: Bearer <token>`.

Auth model in code:

- User JWT with role `administrator` passes role checks.
- M2M JWT passes with required scope.
- `all:marathon-match` and `all:marathon-match-tester` are expanded to their CRUD scopes.

### Public endpoints

| Method | Path | Auth | Notes |
| --- | --- | --- | --- |
| `GET` | `/v6/marathon-match/health` | None | DB health check |
| `GET` | `/v6/marathon-match/api-docs` | None | Swagger docs route |

### Tester endpoints

| Method | Path | Required role/scope |
| --- | --- | --- |
| `POST` | `/v6/marathon-match/testers` | `administrator` OR `create:marathon-match-tester` |
| `GET` | `/v6/marathon-match/testers` | `administrator` OR `read:marathon-match-tester` |
| `GET` | `/v6/marathon-match/testers/:id` | `administrator` OR `read:marathon-match-tester` |
| `PUT` | `/v6/marathon-match/testers/:id` | `administrator` OR `update:marathon-match-tester` |
| `DELETE` | `/v6/marathon-match/testers/:id` | `administrator` OR `delete:marathon-match-tester` |

### Marathon match config endpoints

| Method | Path | Required role/scope |
| --- | --- | --- |
| `POST` | `/v6/marathon-match/challenge/:challengeId` | `administrator` OR `create:marathon-match` |
| `GET` | `/v6/marathon-match/challenge` | `administrator` OR `read:marathon-match` |
| `GET` | `/v6/marathon-match/challenge/:challengeId` | `administrator` OR `read:marathon-match` |
| `GET` | `/v6/marathon-match/challenge/:challengeId/tester-jar` | `administrator` OR `read:marathon-match` |
| `PUT` | `/v6/marathon-match/challenge/:challengeId` | `administrator` OR `update:marathon-match` |
| `DELETE` | `/v6/marathon-match/challenge/:challengeId` | `administrator` OR `delete:marathon-match` |

### Internal scoring callback endpoint

| Method | Path | Required role/scope |
| --- | --- | --- |
| `POST` | `/v6/marathon-match/internal/scoring-results` | `administrator` OR `update:marathon-match` |

## How to set up a challenge for marathon match scoring

### 1. Create a tester

Create a tester (`POST /testers`) with:

- `name`
- `version`
- `className` (fully-qualified Java class with static `runTester(String, ScorerConfig)`)
- `sourceCode`

Compilation is async through pg-boss. The create/update endpoint returns before compilation finishes.

### 2. Wait for compilation success

Poll `GET /testers/:id` until:

- `compilationStatus = SUCCESS`
- `jarFile` is present

If `compilationStatus = FAILED`, update source and recompile via `PUT /testers/:id`.

### 3. Create challenge config

Create config on the challenge id (`POST /challenge/:challengeId`) and include at minimum:

- `testerId` (from step 1)
- `reviewScorecardId`
- `submissionApiUrl`
- `taskDefinitionName`
- `taskDefinitionVersion`
- `active` (`true` to enable scoring)
- phase mappings (`example`, `provisional`, `system`) with:
  - `phaseId` (from challenge-api phase ids)
  - `startSeed`
  - `numberOfTests`

Important runtime behavior:

- Incoming submission events are only processed when config is `active = true`.
- The handler resolves the challenge’s active phase from challenge-api and requires a matching `phaseConfig.phaseId`.
- If no matching phase config exists, the submission is skipped.

### 4. Ensure scorer infrastructure is configured

Before live scoring, verify:

- Kafka topic `marathonmatch.submission.received` is receiving events.
- Service can fetch M2M token (`AUTH0_CLIENT_ID`/`AUTH0_CLIENT_SECRET`).
- ECS env vars are set (`ECS_CLUSTER`, `ECS_SUBNETS`, `ECS_SECURITY_GROUPS`, `ECS_CONTAINER_NAME`, `MARATHON_MATCH_API_URL`, `REVIEW_API_URL`, `REVIEW_TYPE_ID`).
- Task definition referenced by `taskDefinitionName:taskDefinitionVersion` exists and contains the configured container name.

### 5. Optional verification calls

- `GET /challenge/:challengeId` to verify stored config and phase mappings.
- `GET /challenge/:challengeId/tester-jar` to verify compiled jar retrieval.

## ECS runner image (ECR)

The scorer task launched by `EcsService` must reference an ECR image built from:

- `ecs-runner/Dockerfile`

Recommended publish flow:

```bash
AWS_REGION=us-east-1 ECR_REPOSITORY=mm-ecs-runner ./ecs-runner/scripts/build-and-push-ecr.sh
```

Detailed runner image and tagging guidance:

- `ecs-runner/README.md`

## Submission scoring flow (Kafka to score)

```mermaid
sequenceDiagram
  autonumber
  participant K as Kafka Topic<br/>marathonmatch.submission.received
  participant C as KafkaConsumerService
  participant H as MarathonMatchSubmissionHandler
  participant DB as Postgres (Prisma)
  participant CA as challenge-api-v6
  participant ECS as EcsService
  participant F as AWS ECS Fargate Task
  participant MM as marathon-match-api-v6
  participant SA as Submission API
  participant RA as review-api-v6

  K->>C: Submission event (submissionId, challengeId, ...)
  C->>H: handle(payload)
  H->>DB: Load marathonMatchConfig + tester + phaseConfigs

  alt Config missing or inactive
    H-->>C: Skip or throw
  else Config active
    H->>CA: GET /v6/challenges/:challengeId (M2M token)
    CA-->>H: current/open phases

    alt No active phase or no mapped phaseId
      H-->>C: Skip message
    else Phase is mapped
      alt Tester compilationStatus != SUCCESS
        H-->>C: Throw (retry/DLQ path)
      else Tester ready
        H->>ECS: launchScorerTask(configId, submissionId)
        ECS->>F: RunTask with env overrides
        F->>MM: GET /challenge/:id
        F->>MM: GET /challenge/:id/tester-jar
        F->>MM: GET /testers/:testerId
        F->>SA: Download submission artifacts
        F->>F: Load tester JAR + invoke runTester(...)
        F->>MM: POST /internal/scoring-results (score + legacy review payload)
        MM->>RA: POST/PUT /v6/reviews/summations
        F-->>ECS: Task exits
        H-->>C: Success
      end
    end
  end

  C->>C: Commit offset on success/skip
  Note over C: On failures, retries with exponential backoff; if DLQ is enabled and retries are exhausted, publish to topic.dlq and commit.
```
