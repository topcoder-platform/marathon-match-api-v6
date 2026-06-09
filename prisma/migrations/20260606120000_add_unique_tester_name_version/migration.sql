-- Existing databases can contain duplicate tester name/version rows from before
-- the API enforced tester-version uniqueness. Keep the most relevant row for
-- each duplicate group, repoint configs to it, and remove the redundant rows so
-- the unique index can be created safely. Each statement uses its own CTE
-- because Prisma migrate does not keep temporary tables available between all
-- migration statements.
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
),
"duplicateTesters" AS (
    SELECT
        "id" AS "duplicateId",
        "keeperId"
    FROM "rankedTesters"
    WHERE "id" <> "keeperId"
)
UPDATE "marathon_match"."marathonMatchConfig" config
SET "testerId" = duplicates."keeperId"
FROM "duplicateTesters" duplicates
WHERE config."testerId" = duplicates."duplicateId";

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
),
"duplicateTesters" AS (
    SELECT
        "id" AS "duplicateId",
        "keeperId"
    FROM "rankedTesters"
    WHERE "id" <> "keeperId"
)
DELETE FROM "marathon_match"."tester" tester
USING "duplicateTesters" duplicates
WHERE tester."id" = duplicates."duplicateId";

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "tester_name_version_key" ON "marathon_match"."tester"("name", "version");
