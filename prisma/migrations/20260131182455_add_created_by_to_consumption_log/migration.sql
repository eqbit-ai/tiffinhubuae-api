-- AlterTable
ALTER TABLE "ConsumptionLog" ADD COLUMN     "created_by" TEXT;

-- CreateIndex
CREATE INDEX "ConsumptionLog_created_by_idx" ON "ConsumptionLog"("created_by");
