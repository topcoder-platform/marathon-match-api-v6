-- Create table for persisted submission -> ECS runner log mapping.
CREATE TABLE "marathon_match"."submissionRunnerLog" (
    "id" VARCHAR(14) NOT NULL DEFAULT nanoid(),
    "submissionId" TEXT NOT NULL,
    "challengeId" VARCHAR(36) NOT NULL,
    "taskArn" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "cluster" TEXT NOT NULL,
    "containerName" TEXT NOT NULL,
    "taskDefinition" TEXT NOT NULL,
    "phaseConfigType" "marathon_match"."PhaseConfigType",
    "logGroup" TEXT,
    "logStreamPrefix" TEXT,
    "logStreamName" TEXT,
    "cloudWatchLogsConsoleUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "submissionRunnerLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "submissionRunnerLog_taskArn_key"
ON "marathon_match"."submissionRunnerLog"("taskArn");

CREATE INDEX "submissionRunnerLog_submissionId_idx"
ON "marathon_match"."submissionRunnerLog"("submissionId");

CREATE INDEX "submissionRunnerLog_challengeId_idx"
ON "marathon_match"."submissionRunnerLog"("challengeId");

CREATE INDEX "submissionRunnerLog_createdAt_idx"
ON "marathon_match"."submissionRunnerLog"("createdAt");
