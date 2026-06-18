CREATE TABLE "marathon_match"."testSubmissionRun" (
    "id" VARCHAR(14) NOT NULL DEFAULT nanoid(),
    "challengeId" VARCHAR(36) NOT NULL,
    "configType" "marathon_match"."PhaseConfigType" NOT NULL,
    "memberId" TEXT,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT,
    "fileSize" INTEGER NOT NULL,
    "fileContent" BYTEA NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "score" DOUBLE PRECISION,
    "message" TEXT,
    "metadata" JSONB,
    "currentReview" JSONB,
    "impactedReviews" JSONB,
    "progress" DOUBLE PRECISION,
    "completedTests" INTEGER,
    "totalTests" INTEGER,
    "failedTests" INTEGER,
    "taskArn" TEXT,
    "taskId" TEXT,
    "cloudWatchLogsConsoleUrl" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,

    CONSTRAINT "testSubmissionRun_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "testSubmissionRun_challengeId_idx" ON "marathon_match"."testSubmissionRun"("challengeId");
CREATE INDEX "testSubmissionRun_status_idx" ON "marathon_match"."testSubmissionRun"("status");
CREATE INDEX "testSubmissionRun_createdAt_idx" ON "marathon_match"."testSubmissionRun"("createdAt");
