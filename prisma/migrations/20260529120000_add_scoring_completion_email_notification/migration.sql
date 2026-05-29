-- CreateTable
CREATE TABLE "marathon_match"."scoringCompletionEmailNotification" (
    "id" VARCHAR(14) NOT NULL DEFAULT nanoid(),
    "challengeId" VARCHAR(36) NOT NULL,
    "submissionId" TEXT NOT NULL,
    "memberHandle" TEXT,
    "recipientEmail" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PROCESSING',
    "errorMessage" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scoringCompletionEmailNotification_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "scoringCompletionEmailNotification_challengeId_submissionId_key" ON "marathon_match"."scoringCompletionEmailNotification"("challengeId", "submissionId");

-- CreateIndex
CREATE INDEX "scoringCompletionEmailNotification_challengeId_idx" ON "marathon_match"."scoringCompletionEmailNotification"("challengeId");

-- CreateIndex
CREATE INDEX "scoringCompletionEmailNotification_submissionId_idx" ON "marathon_match"."scoringCompletionEmailNotification"("submissionId");

-- CreateIndex
CREATE INDEX "scoringCompletionEmailNotification_status_idx" ON "marathon_match"."scoringCompletionEmailNotification"("status");
