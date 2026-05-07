-- Store Marathon Match phase start seeds as 64-bit integers.
ALTER TABLE "marathon_match"."phaseConfig"
ALTER COLUMN "startSeed" TYPE BIGINT
USING "startSeed"::bigint;
