-- CreateEnum
CREATE TYPE "marathon_match"."ScoreDirection" AS ENUM ('MAXIMIZE', 'MINIMIZE');

-- AlterTable
ALTER TABLE "marathon_match"."marathonMatchConfig"
ADD COLUMN "relativeScoringEnabled" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "scoreDirection" "marathon_match"."ScoreDirection" NOT NULL DEFAULT 'MAXIMIZE';
