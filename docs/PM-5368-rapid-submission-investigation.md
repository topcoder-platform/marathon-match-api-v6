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
  now supplement listing, including legacy runner ownership recovery.
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
