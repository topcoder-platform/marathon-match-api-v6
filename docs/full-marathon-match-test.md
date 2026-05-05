# Full Marathon Match Test Script

`scripts/run-full-marathon-match-test.mjs` drives a full Marathon Match smoke run against deployed Topcoder APIs. It creates a Marathon Match challenge through challenge-api-v6, creates a custom tester from `tester.java`, configures the Marathon Match challenge, registers submitters, submits fixture submissions during the Submission phase, waits for provisional scoring and artifacts, opens Review, waits for SYSTEM scoring on each member's latest submission, and waits for autopilot-v6 to close Review and complete the challenge.

## Fixture Directory

Minimum layout:

```text
fixtures/my-mm/
  tester.java
  marathon-match-test.json
  submissions/
    user-a.zip
    user-b.zip
```

`marathon-match-test.json`:

```json
{
  "challenge": {
    "name": "Production Baseline Full Test Challenge",
    "typeId": "<marathon_match_type_id>",
    "trackId": "<data_science_track_id>",
    "timelineTemplateId": "<marathon_match_timeline_template_id>",
    "projectId": 12345,
    "phaseDurations": {
      "registration": 3600,
      "submission": 3600
    },
    "phaseIds": {
      "registration": "<registration_phase_id>",
      "submission": "<submission_phase_id>"
    }
  },
  "tester": {
    "name": "Production Baseline Tester",
    "version": "2026.04.28.1",
    "className": "Tester"
  },
  "config": {
    "name": "Production Baseline Full Test",
    "relativeScoringEnabled": true,
    "scoreDirection": "MAXIMIZE",
    "example": { "startSeed": 1, "numberOfTests": 10 },
    "provisional": { "startSeed": 753376358, "numberOfTests": 20 },
    "system": { "startSeed": 1651246628, "numberOfTests": 50 }
  },
  "submissions": [
    {
      "memberId": "123456",
      "memberHandle": "user-a",
      "file": "submissions/user-a.zip",
      "expectedScores": {
        "provisional": 97.25,
        "system": 96.5
      }
    },
    {
      "memberId": "234567",
      "memberHandle": "user-b",
      "file": "submissions/user-b.zip"
    }
  ]
}
```

If `submissions` is omitted, submission files can be placed directly in the fixture directory with names like `123456-user-a.zip`. A manifest is recommended because production baselines usually need explicit member IDs, handles, and optional expected scores.

`challenge.typeId` and `challenge.trackId` are required unless supplied by CLI or environment. `timelineTemplateId` is optional only when challenge-api-v6 has a default timeline template for the selected type/track. `projectId` is required when that timeline template requires a project. The script discovers common Registration and Submission phase IDs from `/v6/challenge-phases`; set `challenge.phaseIds` or `--registration-phase-id` / `--submission-phase-id` when an environment uses different phase definitions.

Registration and Submission durations are seconds. They default to `3600` each and can be set with `--registration-duration-seconds`, `--submission-duration-seconds`, `REGISTRATION_DURATION_SECONDS`, `SUBMISSION_DURATION_SECONDS`, or `challenge.phaseDurations`.

The tester source can be a standard Topcoder Marathon tester with a `main(...)` method. The ECS runner handles submission source discovery, compilation, seed execution, aggregate scoring, and `metadata.testScores` output. Custom tester-level `runTester(String, com.topcoder.scorer.models.ScorerConfig)` methods are still supported for special cases.

For advanced create payload fields, add `challenge.createPayload` with any valid `POST /v6/challenges` body fields. The script still applies the configured Registration and Submission duration overrides.

## Create Fixtures from Production

`scripts/create-mm-fixture-from-production.mjs` builds a fixture folder from a production Marathon Match. It searches source submissions by challenge ID, downloads each submission through `GET /v6/submissions/:submissionId/download`, reads review summations for expected provisional/system scores, and writes a `marathon-match-test.json` manifest.

```bash
export TOKEN="<production-m2m-token>"

pnpm fixtures:mm:from-prod -- \
  --source-challenge-id "<production_challenge_id>" \
  --fixture-name "BridgeRunners"
```

The default output is `scripts/fixtures/<fixture-name>/`. Use `--fixture-dir` to choose an exact directory, `--overwrite` to replace an existing manifest/files, `--latest-only` to keep one source submission per production member, or `--max-submissions <n>` for a smaller baseline. If an individual submission download fails, the script logs the failure, skips that submission, and continues with the rest.

The generated manifest intentionally leaves challenge IDs, tester settings, seeds, scorecard/task-definition settings, and test member IDs as placeholders. Replace the generated `memberId` and `memberHandle` values with test users before running the full test. The original production member/submission data is preserved under each entry's `source` object for mapping.

## Required Access

Use an admin token or M2M token that can call:

- `marathon-match-api-v6`: tester and config CRUD
- `challenge-api-v6`: challenge create/update and phase advance
- `resource-api-v6`: create submitter resources
- `review-api-v6`: create/list submissions, list review summations, list artifacts

For local fixture files, configure an S3 upload bucket. The normal active Submission endpoint expects a submission URL, so the script uploads local files first and submits those S3 URLs.

Alternatively, set `MANUAL_SUBMISSION_UPLOAD=true` or pass `--manual-submission-upload` to send local fixture files through review-api-v6 `POST /submissions/manual-upload`. When the Submission phase is open, review-api-v6 must also run with `MANUAL_UPLOAD_ALLOW_OPEN_SUBMISSION_PHASE=true`.

## Example Run

You can copy `scripts/.env.example` to `scripts/.env`, fill in the values, and load it with `set -a; source scripts/.env; set +a` before running the script.

```bash
export TOKEN="<admin-or-m2m-token>"
export TOPCODER_API_BASE="https://api.topcoder-dev.com/v6"
export SUBMISSION_UPLOAD_BUCKET="<bucket-readable-by-av-scan-and-review-api>"
export SUBMISSION_UPLOAD_PREFIX="mm-full-test"
export SUBMITTER_ROLE_ID="<submitter-resource-role-id>"

pnpm test:mm:full -- \
  --fixture-dir ./fixtures/my-mm \
  --challenge-type-id "<marathon_match_type_id>" \
  --challenge-track-id "<data_science_track_id>" \
  --timeline-template-id "<marathon_match_timeline_template_id>" \
  --project-id "12345" \
  --registration-duration-seconds 3600 \
  --submission-duration-seconds 3600 \
  --review-scorecard-id "<scorecard_id>" \
  --task-definition-name "mm-ecs-runner" \
  --task-definition-version "42"
```

The script also accepts `AUTH0_URL`, `AUTH0_CLIENT_ID`, `AUTH0_CLIENT_SECRET`, and `AUTH0_AUDIENCE` instead of `TOKEN`.

If the tester name already exists, the script publishes a new tester version automatically and waits for that version to compile. Use `--reuse-tester` to reuse the latest compiled tester with the same name instead.

Pass `--challenge-id "<challenge_uuid>"` to reuse an existing challenge instead of creating one. This is useful for reruns, but the normal full-test flow creates a fresh challenge.

## Validation

During Submission, every created submission must receive a provisional review summation with a numeric `aggregateScore`. By default, each submission must also have at least one artifact attached through `GET /v6/submissions/:submissionId/artifacts`; override with `--min-artifacts 0` if a tester does not emit artifacts.

During Review, the script waits for a SYSTEM review summation on the latest submission for each member. If `expectedScores.provisional` or `expectedScores.system` is present in the manifest, the script checks the scored value using `--score-tolerance` (default `0.000001`).

Use `--require-test-scores` when the runner should always produce `metadata.testScores`.

## Phase Controls

By default the script:

1. Creates the challenge through `POST /v6/challenges`, unless `--challenge-id` is supplied.
2. Approves the challenge with `PATCH /v6/challenges/:challengeId` and `{"approvalStatus":"APPROVED"}`, then patches it to `ACTIVE` if needed.
3. Opens Registration.
4. Registers submitters.
5. Activates the Marathon Match config.
6. Closes Registration and opens Submission.
7. Creates submissions.
8. Closes Submission and opens Review.
9. Waits for SYSTEM scoring.
10. Waits for autopilot-v6 to close Review and mark the challenge `COMPLETED`.

Useful skip switches:

- `--skip-challenge-launch`
- `--skip-phase-advance`
- `--skip-registration`
- `--skip-config`
- `--skip-final-close` skips the final wait for autopilot-v6 to close Review and complete the challenge.

These are intended for reruns against a challenge that is already in the desired state.
