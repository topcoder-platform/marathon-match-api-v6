# Marathon Match Setup

## Overview

The Scorer section in `marathon-match-api-v6` connects a Marathon Match challenge to a compiled Java tester and the ECS task that runs it. Once the config is active, new submissions can be scored automatically during the Submission phase, and the same tester will be reused for SYSTEM reviews when the Review phase opens.

## Prerequisites

Before configuring a challenge, make sure you have:

- An administrator JWT, a copilot JWT, or an M2M token with `all:marathon-match` and `all:marathon-match-tester`
- ECS infrastructure ready for the scorer task
- Access to the challenge ID in Challenge API
- The tester source code ready in Java

## Step 1 - Create or select a tester

Each Marathon Match config points to a compiled tester record. A tester includes:

- `name`: logical tester name
- `version`: string label for that tester build or family revision
- `className`: fully qualified Java class name
- `sourceCode`: standard Topcoder Marathon tester Java source. A custom `public static runTester(String, ScorerConfig)` method is optional for special-case scorers; the ECS runner provides the default submission compile/run/score flow.

To create a new tester family, call:

`POST /v6/marathon-match/testers`

This route only creates the first version for a tester name. If that tester
family already exists, use `PUT /v6/marathon-match/testers/:id` with a higher
`version`.

To publish a new version of an existing tester, call:

`PUT /v6/marathon-match/testers/:id`

The PUT route creates a new tester record that inherits the existing tester name,
preserves older versions for lookup, and requires the submitted `version` to be
higher than the current max version for that tester family.

To browse available testers without transferring the stored source or compiled jar, call:

`GET /v6/marathon-match/testers`

To load one tester's source, call:

`GET /v6/marathon-match/testers/:id`

Detail and version-create responses omit `jarFile` by default. Add `?includeJarFile=true` only when you explicitly need the compiled jar payload in that response.

Tester compilation is asynchronous. After creating a tester or publishing a new version, poll the tester ID returned by that response:

`GET /v6/marathon-match/testers/:id`

Wait until:

- `compilationStatus = SUCCESS`

If the status becomes `FAILED`:

1. Read `compilationError`
2. Fix the Java source
3. Send another `PUT /v6/marathon-match/testers/:id` with a higher `version`

## Step 2 - Load defaults

Call:

`GET /v6/marathon-match/challenge/defaults`

Use the response to pre-populate:

- `reviewScorecardId`
- `testTimeout`
- `compileTimeout`
- `taskDefinitionName`
- `taskDefinitionVersion`

## Step 3 - Resolve challenge phase IDs

Call:

`GET /v6/challenges/:challengeId`

Map the challenge phase names to the IDs you will store in the Marathon Match config:

- `EXAMPLE`
- `PROVISIONAL`
- `SYSTEM`

Use the phase IDs from the current challenge timeline. If the challenge timeline is recalculated later, the phase IDs can change and the Marathon Match config must be updated to match.

If you want both `EXAMPLE` and `PROVISIONAL` scoring to run on each new submission, map both configs to the same Submission phase ID. The submission handler launches one scorer task per matching phase config.

## Step 4 - Create the challenge config

Create the challenge config with:

`POST /v6/marathon-match/challenge/:challengeId`

Recommended starting point: set `active: false` until the tester and ECS wiring are verified.

The POST request validates the challenge ID against challenge-api and validates `reviewScorecardId` against review-api before saving. If a config already exists for the challenge, the API returns `409 Conflict`.

### Required config fields

| Field | Type | Notes |
| --- | --- | --- |
| `testerId` | string | Compiled tester to use |
| `active` | boolean | Enables scoring when `true` |
| `relativeScoringEnabled` | boolean | Enables relative-score normalization |
| `scoreDirection` | string | `MAXIMIZE` or `MINIMIZE` |
| `reviewScorecardId` | string | Review API scorecard used for summations. Must resolve via review-api using either the canonical scorecard id or a legacy scorecard id. |
| `testTimeout` | number | Test execution timeout |
| `compileTimeout` | number | Submission compile timeout |
| `taskDefinitionName` | string | ECS task definition family |
| `taskDefinitionVersion` | string or number | ECS task definition revision |
| `submissionApiUrl` | string | Base URL for submission downloads |
| `example` | object | Phase config for EXAMPLE scoring |
| `provisional` | object | Phase config for PROVISIONAL scoring |
| `system` | object | Phase config for SYSTEM scoring |

### Phase config object fields

Each of `example`, `provisional`, and `system` must contain:

| Field | Type | Notes |
| --- | --- | --- |
| `phaseId` | string | Canonical challenge phase definition ID from challenge-api `phases[].phaseId` (not the challenge-phase row `id`) |
| `startSeed` | string | Non-negative 64-bit integer stored as PostgreSQL `BIGINT` and passed to the Java runner as a `long`; use a decimal string for full range support (`0..9223372036854775807`) |
| `numberOfTests` | number | Number of test cases to run |

## Step 5 - Activate and verify

When the config is ready, activate it with:

`PUT /v6/marathon-match/challenge/:challengeId`

Body:

```json
{
  "active": true
}
```

Verification calls:

- `GET /v6/marathon-match/challenge/:challengeId`
- `GET /v6/marathon-match/challenge/:challengeId/tester-jar`

## Updating the tester during an active challenge

To switch an active challenge to a newer tester:

1. Publish the new tester version with `PUT /v6/marathon-match/testers/:id`
2. Wait for `GET /v6/marathon-match/testers/:newTesterId` to return `compilationStatus = SUCCESS`
3. Update the challenge config with `PUT /v6/marathon-match/challenge/:challengeId` and the new `testerId`
4. Trigger a rescore of current competitors with `POST /v6/marathon-match/challenge/:challengeId/rerun`

The rerun endpoint selects `isLatest` submissions for the challenge in received order and launches ECS scorer tasks for them in parallel. This does not happen automatically when `testerId` changes, so the rerun call is the operational step that recalculates scores.

Reruns can be requested by admins, M2M tokens with `update:marathon-match`, or the `Copilot` resource assigned to the challenge.

Warning: rerunning after a tester change recalculates scores for all current submitters.

## Rollback

If you need to stop Marathon Match processing immediately, set:

```json
{
  "active": false
}
```

via:

`PUT /v6/marathon-match/challenge/:challengeId`
