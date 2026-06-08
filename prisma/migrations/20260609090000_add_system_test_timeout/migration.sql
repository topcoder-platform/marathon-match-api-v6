-- Add a total SYSTEM scoring timeout in milliseconds.
ALTER TABLE "marathon_match"."marathonMatchConfig"
ADD COLUMN "systemTestTimeout" INTEGER NOT NULL DEFAULT 86400000;
