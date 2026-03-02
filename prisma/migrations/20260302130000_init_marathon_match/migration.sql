-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "marathon_match";

-- Add nanoid support for dbgenerated("nanoid()") defaults.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION nanoid(size int DEFAULT 14)
RETURNS text AS $$
DECLARE
  id text := '';
  i int := 0;
  urlAlphabet char(64) := 'ModuleSymbhasOwnPr-0123456789ABCDEFGHNRVfgctiUvz_KqYTJkLxpZXIjQW';
  bytes bytea := gen_random_bytes(size);
  byte int;
  pos int;
BEGIN
  WHILE i < size LOOP
    byte := get_byte(bytes, i);
    pos := (byte & 63) + 1;
    id := id || substr(urlAlphabet, pos, 1);
    i = i + 1;
  END LOOP;
  RETURN id;
END
$$ LANGUAGE PLPGSQL STABLE;

-- CreateEnum
CREATE TYPE "marathon_match"."PhaseConfigType" AS ENUM ('EXAMPLE', 'PROVISIONAL', 'SYSTEM');

-- CreateEnum
CREATE TYPE "marathon_match"."CompilationStatus" AS ENUM ('PENDING', 'SUCCESS', 'FAILED');

-- CreateTable
CREATE TABLE "marathon_match"."tester" (
    "id" VARCHAR(14) NOT NULL DEFAULT nanoid(),
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "sourceCode" TEXT NOT NULL,
    "jarFile" BYTEA,
    "className" TEXT NOT NULL,
    "compilationStatus" "marathon_match"."CompilationStatus" NOT NULL DEFAULT 'PENDING',
    "compilationError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "tester_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marathon_match"."marathonMatchConfig" (
    "id" VARCHAR(36) NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "submissionApiUrl" TEXT NOT NULL DEFAULT 'https://api.topcoder-dev.com/v6',
    "reviewScorecardId" TEXT NOT NULL,
    "testerId" VARCHAR(14) NOT NULL,
    "testTimeout" INTEGER NOT NULL,
    "compileTimeout" INTEGER NOT NULL,
    "taskDefinitionName" TEXT NOT NULL,
    "taskDefinitionVersion" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT,
    "updatedBy" TEXT,

    CONSTRAINT "marathonMatchConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "marathon_match"."phaseConfig" (
    "id" VARCHAR(14) NOT NULL DEFAULT nanoid(),
    "marathonMatchConfigId" VARCHAR(36) NOT NULL,
    "configType" "marathon_match"."PhaseConfigType" NOT NULL,
    "startSeed" INTEGER NOT NULL,
    "numberOfTests" INTEGER NOT NULL,
    "phaseId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "phaseConfig_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "tester_id_idx" ON "marathon_match"."tester"("id");

-- CreateIndex
CREATE INDEX "tester_name_idx" ON "marathon_match"."tester"("name");

-- CreateIndex
CREATE INDEX "tester_compilationStatus_idx" ON "marathon_match"."tester"("compilationStatus");

-- CreateIndex
CREATE INDEX "marathonMatchConfig_id_idx" ON "marathon_match"."marathonMatchConfig"("id");

-- CreateIndex
CREATE INDEX "marathonMatchConfig_testerId_idx" ON "marathon_match"."marathonMatchConfig"("testerId");

-- CreateIndex
CREATE INDEX "marathonMatchConfig_active_idx" ON "marathon_match"."marathonMatchConfig"("active");

-- CreateIndex
CREATE INDEX "phaseConfig_marathonMatchConfigId_idx" ON "marathon_match"."phaseConfig"("marathonMatchConfigId");

-- CreateIndex
CREATE INDEX "phaseConfig_configType_idx" ON "marathon_match"."phaseConfig"("configType");

-- CreateIndex
CREATE INDEX "phaseConfig_phaseId_idx" ON "marathon_match"."phaseConfig"("phaseId");

-- CreateIndex
CREATE UNIQUE INDEX "phaseConfig_marathonMatchConfigId_configType_key" ON "marathon_match"."phaseConfig"("marathonMatchConfigId", "configType");

-- AddForeignKey
ALTER TABLE "marathon_match"."marathonMatchConfig" ADD CONSTRAINT "marathonMatchConfig_testerId_fkey" FOREIGN KEY ("testerId") REFERENCES "marathon_match"."tester"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "marathon_match"."phaseConfig" ADD CONSTRAINT "phaseConfig_marathonMatchConfigId_fkey" FOREIGN KEY ("marathonMatchConfigId") REFERENCES "marathon_match"."marathonMatchConfig"("id") ON DELETE CASCADE ON UPDATE CASCADE;
