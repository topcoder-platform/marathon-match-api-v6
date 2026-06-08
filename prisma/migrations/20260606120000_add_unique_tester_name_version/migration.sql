-- CreateIndex
CREATE UNIQUE INDEX "tester_name_version_key" ON "marathon_match"."tester"("name", "version");
