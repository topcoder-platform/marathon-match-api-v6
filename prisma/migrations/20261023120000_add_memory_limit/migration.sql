-- Add an optional ECS scorer task memory override in MiB.
-- NULL keeps the memory configured on the ECS task definition revision.
ALTER TABLE "marathon_match"."marathonMatchConfig"
ADD COLUMN "memoryLimit" INTEGER;
