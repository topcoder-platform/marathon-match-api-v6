# PM-5368: rapid Marathon Match submissions

Investigated `origin/develop` at `fd72835` and platform-ui `origin/dev` at
`9d879b43d`, including the earlier PM-5368 fixes (`f72fc17` and `274ae97`).
The earlier changes associated member IDs with ECS tasks, wrote cancellation
summations, and protected cancelled summations from late callbacks. The September
2 change added a newest-clean-submission preflight, but several gaps remained.

## Confirmed gaps and changes

- Opportunities did not recognize `CANCELLED`; its status could be blank, the
  `-1` placeholder could display as a score, and stale positive cancelled results
  could enter the dashboard. The companion UI PR adds a neutral Cancelled state,
  resolves the newest result per phase, and excludes cancelled phase scores.
- Cancellation silently returned an empty result when ECS inspection was denied.
  Member launches now require successful inspection instead of bypassing the
  member replacement and capacity checks.
- ECS stopped tasks before Review API persisted cancellation. If that write
  failed, the next retry could no longer discover the stopped task and record its
  terminal status. Cancellation now persists before stopping; persistence failure
  prevents both the stop and replacement launch.
- Cancellation and launch had separate process-local locks. The authoritative
  newest lookup and complete replacement operation now run under one
  challenge/member PostgreSQL advisory lock shared by API replicas.
- Fast successive events depended only on `ListTasks` immediately seeing the
  previous launch. Persisted runner ARNs for the member's verified submissions
  now supplement listing, including legacy runner ownership recovery. The
  submission ID lookup includes rows whose virus-scan flag is absent from the
  list response, while newest-scorer selection still requires a clean row.
- Desired `STOPPED` was treated as completed shutdown. The replacement path now
  includes stopping tasks and waits for actual shutdown before launching, and
  never reuses a duplicate that is already stopping.

The underlying AWS behavior is documented in
[StopTask](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_StopTask.html)
and [ListTasks](https://docs.aws.amazon.com/AmazonECS/latest/APIReference/API_ListTasks.html).
These are reproducible code gaps; the expired local AWS session prevented live
log inspection, so this investigation does not claim which one caused the exact
QA challenge `a83d85a4-052b-420b-9121-95936227c150`.

## Validation and rollout

All 30 Marathon API suites (226 tests), lint, and build pass on Node 26.5.1.
Tests cover cancellation persistence failure, denied inspection, persisted ARN
recovery, stopping tasks, stale events, late callbacks, and member lock boundaries.
The new ECS regression cases fail seven tests on unchanged `fd72835` and pass
with this fix. The companion Opportunities changes pass 111 tests across three
suites; four new utility cases fail on unchanged `9d879b43d`.
A separate PostgreSQL 16 integration check with dedicated connections confirms
same-member serialization, independent-member progress, and release after failed
dispatch. Its temporary database was stopped after testing.

Deploy with the companion platform-ui PM-5368 PR. The API role must have
`ecs:ListTasks`, `ecs:DescribeTasks`, and `ecs:StopTask` alongside existing launch
permissions. `DATABASE_URL` already used by Marathon API also supplies the member
lock connection. No database migration is required. Failed operations retain the
existing Kafka retry/DLQ behavior and require normal DLQ replay after an outage.

QA should submit A and then B before A completes, verify A's relevant summations
are Cancelled, confirm A's tasks reach actual STOPPED before B's tasks start,
and confirm B receives normal progress and scoring results. Repeat with delayed
events, duplicated events, two API replicas, another member, and transient Review
API failure. A stale event must never cancel B's scorer. Existing separately
configured EXAMPLE/PROVISIONAL tasks for one submission remain supported; the
replacement rule removes tasks for superseded submissions.

## September 24 QA follow-up

QA challenge `7599d6dd-50c6-4f9f-a243-c420f10b4881` still left the second
submission in Preparing. For all three members tested, Review API and
submission-api show the same pattern:

- Only the older submission's EXAMPLE summation was written as `CANCELLED`, one
  second after the newer submission arrived.
- The older submission's EXAMPLE artifact was still uploaded.
- Its PROVISIONAL task ran to completion.
- The newer submission has no summations and no artifacts.

The EXAMPLE task therefore never stopped, and the handler never reached the
PROVISIONAL task or the replacement launch. This matches `StopTask` throwing on
the first superseded task. The most likely cause is a missing `ecs:StopTask`
grant on the API role. With `KAFKA_DLQ_ENABLED` unset, the consumer commits a
failed event without retrying, so the newest submission was dropped.

Cancellation is now best-effort. The handler logs per-task persistence,
`StopTask`, and shutdown-confirmation failures, moves on to the remaining tasks,
and always dispatches the newest submission. The API role still needs
`ecs:StopTask` in each environment for the one-scorer-per-member limit to hold.
Search the API logs for `Failed to stop superseded ECS scorer task` to confirm.
