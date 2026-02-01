-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "dietary_preference" TEXT DEFAULT 'Both',
ADD COLUMN     "original_end_date" TEXT,
ADD COLUMN     "pause_history" JSONB,
ADD COLUMN     "pause_resume_date" TEXT,
ADD COLUMN     "pause_start_date" TEXT,
ADD COLUMN     "total_pause_days" INTEGER DEFAULT 0;
