-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "is_trial" BOOLEAN DEFAULT false,
ADD COLUMN     "trial_converted" BOOLEAN DEFAULT false,
ADD COLUMN     "trial_end_date" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "MealRating" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "order_id" TEXT,
    "rating" INTEGER NOT NULL DEFAULT 0,
    "feedback" TEXT,
    "meal_type" TEXT,
    "meal_date" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealRating_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "customer_phone" TEXT,
    "customer_address" TEXT,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "tax_amount" DOUBLE PRECISION DEFAULT 0,
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT DEFAULT 'AED',
    "period_start" TIMESTAMP(3),
    "period_end" TIMESTAMP(3),
    "status" TEXT DEFAULT 'generated',
    "trn_number" TEXT,
    "business_name" TEXT,
    "business_address" TEXT,
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MealRating_created_by_idx" ON "MealRating"("created_by");

-- CreateIndex
CREATE INDEX "MealRating_customer_id_idx" ON "MealRating"("customer_id");

-- CreateIndex
CREATE INDEX "Invoice_created_by_idx" ON "Invoice"("created_by");

-- CreateIndex
CREATE INDEX "Invoice_customer_id_idx" ON "Invoice"("customer_id");
