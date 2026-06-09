-- Existing databases can contain duplicate tester name/version rows from before
-- the API enforced tester-version uniqueness. Keep the most relevant row for
-- each duplicate group, repoint configs to it, and remove the redundant rows so
-- the unique index can be created safely.
CREATE TEMP TABLE "_tester_name_version_duplicates" ON COMMIT DROP AS
WITH "testerUsage" AS (
    SELECT
        tester."id",
        COUNT(config."id") AS "configCount"
    FROM "marathon_match"."tester" tester
    LEFT JOIN "marathon_match"."marathonMatchConfig" config
        ON config."testerId" = tester."id"
    GROUP BY tester."id"
),
"rankedTesters" AS (
    SELECT
        tester."id",
        FIRST_VALUE(tester."id") OVER (
            PARTITION BY tester."name", tester."version"
            ORDER BY
                "testerUsage"."configCount" DESC,
                (tester."compilationStatus" = 'SUCCESS' AND tester."jarFile" IS NOT NULL) DESC,
                (tester."compilationStatus" = 'SUCCESS') DESC,
                tester."updatedAt" DESC,
                tester."createdAt" DESC,
                tester."id" ASC
        ) AS "keeperId"
    FROM "marathon_match"."tester" tester
    INNER JOIN "testerUsage"
        ON "testerUsage"."id" = tester."id"
)
SELECT
    "id" AS "duplicateId",
    "keeperId"
FROM "rankedTesters"
WHERE "id" <> "keeperId";

UPDATE "marathon_match"."marathonMatchConfig" config
SET "testerId" = duplicates."keeperId"
FROM "_tester_name_version_duplicates" duplicates
WHERE config."testerId" = duplicates."duplicateId";

DELETE FROM "marathon_match"."tester" tester
USING "_tester_name_version_duplicates" duplicates
WHERE tester."id" = duplicates."duplicateId";

-- CreateIndex
CREATE UNIQUE INDEX "tester_name_version_key" ON "marathon_match"."tester"("name", "version");
