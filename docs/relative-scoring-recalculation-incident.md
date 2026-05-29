# Relative Scoring Recalculation Incident

## Summary

Production relative scoring on challenge `3188f834-cc35-4a49-b9ce-1d7f49be5e6d`
is recalculating against the wrong impacted submission set. The normalization
math matches the legacy helper, but `ScoringResultService` is not reliably
selecting the latest scored submission for each member before it computes
per-testcase best scores.

## Root Cause

`src/api/scoring-result/scoring-result.service.ts` selects impacted reviews in
`selectLatestRelativeReviewRecords(...)`. That method reads only
`submission.created` when comparing submissions for the same member:

```ts
const createdAt = this.asString(submission.created);
...
this.compareIsoDateStrings(createdAt, existing.createdAt) >= 0
```

The production `/v6/submissions` payload for this challenge does not include
`created`. It includes `submittedDate`, `createdAt`, `updatedAt`, and
`isLatest`.

Because both compared timestamps are `undefined`,
`compareIsoDateStrings(undefined, undefined)` returns `0`, and the `>= 0`
comparison overwrites the selected submission every time another review
summation for that member appears in API response order. The API response is
newest first for this challenge, so the final retained record is usually the
oldest submission with any matching phase summation, not the latest one.

If that retained older summation has no usable `metadata.testScores`,
`buildRelativeReviewRecord(...)` filters it out. That member is then omitted
from recalculation entirely, so their persisted leaderboard score remains
unchanged even though another submission improved one or more testcase bests.

## Production Reproduction

Using a token from `/home/jmgasper/prod_token.sh`, the protected submission API
returned 49 submissions for the challenge. The payload has this date shape:

```json
{
  "submittedDate": "2026-05-29T01:14:16.543Z",
  "createdAt": "2026-05-29T01:14:16.544Z",
  "updatedAt": "2026-05-29T01:14:17.712Z",
  "isLatest": true
}
```

There is no `created` field.

Emulating the current v6 selection logic at eulerscheZahl's starter-code
submission `ingZJHPdUwlmSh` from `2026-05-28T15:21:12.605Z` reproduces the
reported "before" screenshot:

| Handle | Recomputed score | Selected submission |
| --- | ---: | --- |
| Tsegaye16 | `85.821483267118353` | `4mU9IbKArL8iLR` |
| Bitreliica | `79.510692325569394` | `O1w7qYDln532IQ` |
| kazaward | `0.004946668727779` | `I47EWr29tlU0XS` |
| eulerscheZahl | `0.004946668727779` | `ingZJHPdUwlmSh` |

Emulating the same current logic at eulerscheZahl's stronger submission
`jsnlKenclAtOwQ` from `2026-05-28T15:23:32.877Z` reproduces the reported
"after" screenshot:

| Handle | Recomputed score | Selected submission |
| --- | ---: | --- |
| eulerscheZahl | `99.231956887223333` | `jsnlKenclAtOwQ` |
| Tsegaye16 | `54.342877815539815` | `4mU9IbKArL8iLR` |
| Bitreliica | `44.002849917300416` | `O1w7qYDln532IQ` |
| kazaward | `0.001900688999762` | `I47EWr29tlU0XS` |

The same emulation selects these older/invalid submissions for users who were
reported as unaffected:

| Handle | Wrongly selected submission | Why it does not get updated |
| --- | --- | --- |
| Ghostar2020 | `juoSHPLKrxivFq` | provisional summation has no usable `testScores`, so the member is filtered out |
| vdave | `6HtDY92-hO_Spz` | no usable provisional `testScores`, so the member is filtered out |

This explains why some users dropped while others did not: the best-score set
and the impacted update list were built from a stale or empty per-member
selection.

## Legacy Comparison

The legacy helper in
`/home/jmgasper/Documents/Git/marathon-match-testers/tc-mm-164/tester_code/tester/src/main/java/com/topcoder/ReviewHelper/ReviewHelper.java`
uses the same relative-score formula:

- choose max or min raw score per testcase based on score direction
- failed or negative testcase scores do not contribute to bests
- relative score is `(lower / higher) * 100`
- aggregate is the average of relative testcase scores

The behavioral difference is the selection input. The legacy code tracked a
member timestamp from the submission payload it was built against. The v6 code
kept the old `created` field name, but the current production submission
payload no longer provides that field.

## Fix Boundary

The first runtime fix should be limited to impacted-review selection:

- normalize submission timestamps with the same field fallbacks used by rerun
  dispatch: `submittedDate`, `receivedDate`, `receivedAt`, `createdAt`,
  `updatedAt`, then legacy `created`
- use that normalized timestamp when selecting one submission per member
- add regression coverage with multiple submissions for a member where the API
  payload has `createdAt` but no `created`
- include a case where an older failed/no-testScores summation would currently
  overwrite and drop a newer valid summation

The score normalization formula itself should not be changed as part of this
fix unless a separate scoring-policy decision is made.
