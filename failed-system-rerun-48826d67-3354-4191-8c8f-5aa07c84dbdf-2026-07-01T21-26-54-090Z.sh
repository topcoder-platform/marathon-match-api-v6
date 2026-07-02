#!/usr/bin/env bash
set -euo pipefail

: "${TOKEN:?Set TOKEN to an admin/M2M bearer token}"
MM_API_BASE="${MM_API_BASE:-https://api.topcoder.com/v6/marathon-match}"
DELAY_SECONDS="${FAILED_SYSTEM_RERUN_DELAY_SECONDS:-0}"

echo "Dispatching review 4f923f63-57d6-47cc-861e-38d71b564a22 for submission -kJ-nOos4KQaL3"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"4f923f63-57d6-47cc-861e-38d71b564a22","submissionId":"-kJ-nOos4KQaL3"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review de224678-76cf-439e-bae8-67827cd5889d for submission -XseogN8tWUYv9"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"de224678-76cf-439e-bae8-67827cd5889d","submissionId":"-XseogN8tWUYv9"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 0d8f13a1-ac02-4f75-bd10-582293fc44b3 for submission 0wGavBBuHVPRAm"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"0d8f13a1-ac02-4f75-bd10-582293fc44b3","submissionId":"0wGavBBuHVPRAm"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review d6354bbe-c309-4932-be79-70e40e6ec2ff for submission 3kONG53Rspsc2X"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"d6354bbe-c309-4932-be79-70e40e6ec2ff","submissionId":"3kONG53Rspsc2X"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 37adfa56-f824-47d0-a3af-19ab4640f760 for submission 464rSXUx0aQzHk"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"37adfa56-f824-47d0-a3af-19ab4640f760","submissionId":"464rSXUx0aQzHk"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review f33e8cb0-5bca-47d3-9784-611d3e94ec38 for submission 4lJclQqEia-Kaq"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"f33e8cb0-5bca-47d3-9784-611d3e94ec38","submissionId":"4lJclQqEia-Kaq"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 551be25b-c101-43e8-a6e9-c19b3ae6c018 for submission 67iZ6H3GQFFzjs"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"551be25b-c101-43e8-a6e9-c19b3ae6c018","submissionId":"67iZ6H3GQFFzjs"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 5f95dfae-5901-428c-b243-012c6d68e9df for submission AfhrQkoDWXyCfd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"5f95dfae-5901-428c-b243-012c6d68e9df","submissionId":"AfhrQkoDWXyCfd"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review b2a1ab3b-65a8-4b4d-b93c-1bc557a3722a for submission aXzej5sv5FCMYV"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"b2a1ab3b-65a8-4b4d-b93c-1bc557a3722a","submissionId":"aXzej5sv5FCMYV"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 6b1c0476-4d05-4c46-9b67-2d860de22a01 for submission B-XVLtUga3AhAC"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"6b1c0476-4d05-4c46-9b67-2d860de22a01","submissionId":"B-XVLtUga3AhAC"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review d91d2270-2b62-4cef-bbe4-54010e580a27 for submission b5-cpwFqfdcy8D"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"d91d2270-2b62-4cef-bbe4-54010e580a27","submissionId":"b5-cpwFqfdcy8D"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 3135bdf6-4a85-4c2a-9b10-14e5d7a0cb94 for submission b72jM5-X00DcUV"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"3135bdf6-4a85-4c2a-9b10-14e5d7a0cb94","submissionId":"b72jM5-X00DcUV"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review f5a411b3-ce6f-4da0-b4ba-68ca9df91d43 for submission BVdlowg4Lsy7As"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"f5a411b3-ce6f-4da0-b4ba-68ca9df91d43","submissionId":"BVdlowg4Lsy7As"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review e5af0e91-9459-43fb-a2f6-7ea6a541cd89 for submission FvwbmtBOkyfGdD"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"e5af0e91-9459-43fb-a2f6-7ea6a541cd89","submissionId":"FvwbmtBOkyfGdD"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 3ac26bfb-cc69-4530-9e78-b55ed58cee17 for submission GEAksgekpuPCeO"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"3ac26bfb-cc69-4530-9e78-b55ed58cee17","submissionId":"GEAksgekpuPCeO"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 9fb495fd-1481-4a92-addd-af26241b7ac1 for submission hAq--Rd0DCf8Gz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"9fb495fd-1481-4a92-addd-af26241b7ac1","submissionId":"hAq--Rd0DCf8Gz"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review f07cc05d-adde-456a-8c1a-fe5520ed961b for submission he6WzVNcc_daZR"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"f07cc05d-adde-456a-8c1a-fe5520ed961b","submissionId":"he6WzVNcc_daZR"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review f9b95f9c-55c4-4bc0-b585-35435aa6d728 for submission IJaRGgB9EGkeNt"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"f9b95f9c-55c4-4bc0-b585-35435aa6d728","submissionId":"IJaRGgB9EGkeNt"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review dab539ff-250c-44f4-9e8c-493b712d7839 for submission K0UbtNIuWpH7W1"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"dab539ff-250c-44f4-9e8c-493b712d7839","submissionId":"K0UbtNIuWpH7W1"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 7c942dcd-dd90-46a6-855c-e2a6602bb494 for submission k8yTJ5Cb7gtHrp"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"7c942dcd-dd90-46a6-855c-e2a6602bb494","submissionId":"k8yTJ5Cb7gtHrp"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review a2ed34d4-62ec-4acb-a28c-55211337d719 for submission KDLZsRDsgzJy_F"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"a2ed34d4-62ec-4acb-a28c-55211337d719","submissionId":"KDLZsRDsgzJy_F"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review fcaa2874-0634-4fbc-be15-cecc9816aca2 for submission KNK5qu5ny94P5_"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"fcaa2874-0634-4fbc-be15-cecc9816aca2","submissionId":"KNK5qu5ny94P5_"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review cb1ba2e3-6e40-435f-88aa-66f18c592905 for submission l15vteqGkA4Cdz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"cb1ba2e3-6e40-435f-88aa-66f18c592905","submissionId":"l15vteqGkA4Cdz"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 21edbf45-7d3a-4996-8479-a45b8a0c0ac7 for submission l8Ogeb3iMc9PL7"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"21edbf45-7d3a-4996-8479-a45b8a0c0ac7","submissionId":"l8Ogeb3iMc9PL7"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review de51027f-10ba-46d0-8e6e-73a378722ff1 for submission Lk7FBfpk2PY-QI"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"de51027f-10ba-46d0-8e6e-73a378722ff1","submissionId":"Lk7FBfpk2PY-QI"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review fb77c1d1-8f34-48f5-8741-b88665f579f4 for submission Ma-1c0Di2Ihu2R"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"fb77c1d1-8f34-48f5-8741-b88665f579f4","submissionId":"Ma-1c0Di2Ihu2R"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 124ca3dc-60f9-40f3-815b-920f221b1224 for submission mqoN5fmFUaLCrd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"124ca3dc-60f9-40f3-815b-920f221b1224","submissionId":"mqoN5fmFUaLCrd"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review b36e7ce0-177d-4ae1-bb60-017a14236db5 for submission OPHSZK0yICSTZA"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"b36e7ce0-177d-4ae1-bb60-017a14236db5","submissionId":"OPHSZK0yICSTZA"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 12875786-b6e2-4533-a20a-d66daf795d2d for submission oRvp_5_mUdPIm-"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"12875786-b6e2-4533-a20a-d66daf795d2d","submissionId":"oRvp_5_mUdPIm-"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 0986e913-49d8-472b-900c-32f236f37253 for submission OvhNb7WTRUheSO"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"0986e913-49d8-472b-900c-32f236f37253","submissionId":"OvhNb7WTRUheSO"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 173a2093-8e9e-4cf3-b57b-db890451ef1a for submission p4fNGII3eANhbp"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"173a2093-8e9e-4cf3-b57b-db890451ef1a","submissionId":"p4fNGII3eANhbp"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review c2ad3c5e-0bc2-4a9b-99cd-fb214d334210 for submission pjxTnWMmGFrSzN"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"c2ad3c5e-0bc2-4a9b-99cd-fb214d334210","submissionId":"pjxTnWMmGFrSzN"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review b55c6d38-2d1b-4869-9dd4-7fbb67163ab1 for submission Q18Zp5P1RoHtXd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"b55c6d38-2d1b-4869-9dd4-7fbb67163ab1","submissionId":"Q18Zp5P1RoHtXd"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 194fc457-c1a9-41d8-b550-63c06f05071b for submission qCi-PzVugNi6JU"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"194fc457-c1a9-41d8-b550-63c06f05071b","submissionId":"qCi-PzVugNi6JU"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review a0a1e6d1-2f91-4397-946b-b4a41929f703 for submission qwk7d0PBsfgp5L"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"a0a1e6d1-2f91-4397-946b-b4a41929f703","submissionId":"qwk7d0PBsfgp5L"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 54aab364-88a7-4cc0-a52e-4c28949395ed for submission sGOUPQDZbM3Yrm"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"54aab364-88a7-4cc0-a52e-4c28949395ed","submissionId":"sGOUPQDZbM3Yrm"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 8da1b643-0f3d-4547-90bd-0acea2dfd66e for submission tXLS9u-Rkpg4iM"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"8da1b643-0f3d-4547-90bd-0acea2dfd66e","submissionId":"tXLS9u-Rkpg4iM"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review a906e1f3-fac1-429a-82dd-b50242165a54 for submission UMM1Q8ojXGTcRd"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"a906e1f3-fac1-429a-82dd-b50242165a54","submissionId":"UMM1Q8ojXGTcRd"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 03a3a1a4-c01f-4f9f-b821-8ef556828768 for submission VO3lr2ohElhKl8"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"03a3a1a4-c01f-4f9f-b821-8ef556828768","submissionId":"VO3lr2ohElhKl8"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 42b19da5-5d38-4e3c-94e2-1f779ee52ec7 for submission wa4JVG90L64Tye"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"42b19da5-5d38-4e3c-94e2-1f779ee52ec7","submissionId":"wa4JVG90L64Tye"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 2b82a770-b672-4ccb-a156-1167089b71ce for submission WhDhl-vIvAyZeV"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"2b82a770-b672-4ccb-a156-1167089b71ce","submissionId":"WhDhl-vIvAyZeV"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 7f15d379-e2f9-4cf5-85a5-6b422c0f3c24 for submission wmW4O1loZwm_Jf"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"7f15d379-e2f9-4cf5-85a5-6b422c0f3c24","submissionId":"wmW4O1loZwm_Jf"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review e56237db-2798-47da-91d5-ae22ee9a1b20 for submission wzA0EP_nDbehGe"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"e56237db-2798-47da-91d5-ae22ee9a1b20","submissionId":"wzA0EP_nDbehGe"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 40af2f96-eb7c-4e71-87c8-e53e52028abe for submission xbmrVhfrNEm5MR"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"40af2f96-eb7c-4e71-87c8-e53e52028abe","submissionId":"xbmrVhfrNEm5MR"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review ee0c33e5-9765-4864-a2fa-dd45ee0a012c for submission xcnR4pt5oG_qAS"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"ee0c33e5-9765-4864-a2fa-dd45ee0a012c","submissionId":"xcnR4pt5oG_qAS"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review c1198585-0de7-436f-9dfb-8b9a6e9bb27a for submission Y1GuZxfIGEoHAz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"c1198585-0de7-436f-9dfb-8b9a6e9bb27a","submissionId":"Y1GuZxfIGEoHAz"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review bd3c7697-4613-4846-a7f4-e0e049139d5c for submission z3oqSF0xWM93_M"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"bd3c7697-4613-4846-a7f4-e0e049139d5c","submissionId":"z3oqSF0xWM93_M"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

echo "Dispatching review 3028ff05-e8e5-4b73-8920-d443fc9bf123 for submission zBZ1l8bFCN-Dfz"
curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data '{"challengeId":"48826d67-3354-4191-8c8f-5aa07c84dbdf","reviewId":"3028ff05-e8e5-4b73-8920-d443fc9bf123","submissionId":"zBZ1l8bFCN-Dfz"}'
if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi

