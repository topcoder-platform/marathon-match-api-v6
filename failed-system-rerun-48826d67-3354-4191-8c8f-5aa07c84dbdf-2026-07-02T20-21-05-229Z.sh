#!/usr/bin/env bash
set -euo pipefail

: "${TOKEN:?Set TOKEN to an admin/M2M bearer token}"
MM_API_BASE="${MM_API_BASE:-https://api.topcoder.com/v6/marathon-match}"
DELAY_SECONDS="${FAILED_SYSTEM_RERUN_DELAY_SECONDS:-0}"
MAX_DISPATCHES="${FAILED_SYSTEM_RERUN_MAX_DISPATCHES:-20}"
DISPATCHED=0

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 124ca3dc-60f9-40f3-815b-920f221b1224 for submission mqoN5fmFUaLCrd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"124ca3dc-60f9-40f3-815b-920f221b1224","submissionId":"mqoN5fmFUaLCrd"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review b36e7ce0-177d-4ae1-bb60-017a14236db5 for submission OPHSZK0yICSTZA"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"b36e7ce0-177d-4ae1-bb60-017a14236db5","submissionId":"OPHSZK0yICSTZA"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 12875786-b6e2-4533-a20a-d66daf795d2d for submission oRvp_5_mUdPIm-"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"12875786-b6e2-4533-a20a-d66daf795d2d","submissionId":"oRvp_5_mUdPIm-"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 0986e913-49d8-472b-900c-32f236f37253 for submission OvhNb7WTRUheSO"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"0986e913-49d8-472b-900c-32f236f37253","submissionId":"OvhNb7WTRUheSO"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 173a2093-8e9e-4cf3-b57b-db890451ef1a for submission p4fNGII3eANhbp"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"173a2093-8e9e-4cf3-b57b-db890451ef1a","submissionId":"p4fNGII3eANhbp"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review c2ad3c5e-0bc2-4a9b-99cd-fb214d334210 for submission pjxTnWMmGFrSzN"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"c2ad3c5e-0bc2-4a9b-99cd-fb214d334210","submissionId":"pjxTnWMmGFrSzN"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review b55c6d38-2d1b-4869-9dd4-7fbb67163ab1 for submission Q18Zp5P1RoHtXd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"b55c6d38-2d1b-4869-9dd4-7fbb67163ab1","submissionId":"Q18Zp5P1RoHtXd"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 194fc457-c1a9-41d8-b550-63c06f05071b for submission qCi-PzVugNi6JU"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"194fc457-c1a9-41d8-b550-63c06f05071b","submissionId":"qCi-PzVugNi6JU"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review a0a1e6d1-2f91-4397-946b-b4a41929f703 for submission qwk7d0PBsfgp5L"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"a0a1e6d1-2f91-4397-946b-b4a41929f703","submissionId":"qwk7d0PBsfgp5L"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 54aab364-88a7-4cc0-a52e-4c28949395ed for submission sGOUPQDZbM3Yrm"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"54aab364-88a7-4cc0-a52e-4c28949395ed","submissionId":"sGOUPQDZbM3Yrm"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 8da1b643-0f3d-4547-90bd-0acea2dfd66e for submission tXLS9u-Rkpg4iM"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"8da1b643-0f3d-4547-90bd-0acea2dfd66e","submissionId":"tXLS9u-Rkpg4iM"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review a906e1f3-fac1-429a-82dd-b50242165a54 for submission UMM1Q8ojXGTcRd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"a906e1f3-fac1-429a-82dd-b50242165a54","submissionId":"UMM1Q8ojXGTcRd"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 03a3a1a4-c01f-4f9f-b821-8ef556828768 for submission VO3lr2ohElhKl8"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"03a3a1a4-c01f-4f9f-b821-8ef556828768","submissionId":"VO3lr2ohElhKl8"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 42b19da5-5d38-4e3c-94e2-1f779ee52ec7 for submission wa4JVG90L64Tye"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"42b19da5-5d38-4e3c-94e2-1f779ee52ec7","submissionId":"wa4JVG90L64Tye"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 2b82a770-b672-4ccb-a156-1167089b71ce for submission WhDhl-vIvAyZeV"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"2b82a770-b672-4ccb-a156-1167089b71ce","submissionId":"WhDhl-vIvAyZeV"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 7f15d379-e2f9-4cf5-85a5-6b422c0f3c24 for submission wmW4O1loZwm_Jf"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"7f15d379-e2f9-4cf5-85a5-6b422c0f3c24","submissionId":"wmW4O1loZwm_Jf"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 40af2f96-eb7c-4e71-87c8-e53e52028abe for submission xbmrVhfrNEm5MR"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"40af2f96-eb7c-4e71-87c8-e53e52028abe","submissionId":"xbmrVhfrNEm5MR"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review ee0c33e5-9765-4864-a2fa-dd45ee0a012c for submission xcnR4pt5oG_qAS"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"ee0c33e5-9765-4864-a2fa-dd45ee0a012c","submissionId":"xcnR4pt5oG_qAS"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review c1198585-0de7-436f-9dfb-8b9a6e9bb27a for submission Y1GuZxfIGEoHAz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"c1198585-0de7-436f-9dfb-8b9a6e9bb27a","submissionId":"Y1GuZxfIGEoHAz"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review bd3c7697-4613-4846-a7f4-e0e049139d5c for submission z3oqSF0xWM93_M"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"bd3c7697-4613-4846-a7f4-e0e049139d5c","submissionId":"z3oqSF0xWM93_M"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then
  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."
  exit 0
fi
echo "Dispatching review 3028ff05-e8e5-4b73-8920-d443fc9bf123 for submission zBZ1l8bFCN-Dfz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"3028ff05-e8e5-4b73-8920-d443fc9bf123","submissionId":"zBZ1l8bFCN-Dfz"}'
DISPATCHED=$((DISPATCHED + 1))
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

