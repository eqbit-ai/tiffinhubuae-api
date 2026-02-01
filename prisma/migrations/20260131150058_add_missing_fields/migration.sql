-- AlterTable
ALTER TABLE "Customer" ADD COLUMN     "is_paused" BOOLEAN DEFAULT false;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "amount_to_collect" DOUBLE PRECISION,
ADD COLUMN     "customer_id" TEXT,
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "days_left" INTEGER,
ADD COLUMN     "email_sent" BOOLEAN DEFAULT false,
ADD COLUMN     "is_read" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "notification_type" TEXT,
ADD COLUMN     "phone_number" TEXT;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "delivery_status" TEXT DEFAULT 'pending',
ADD COLUMN     "order_date" TEXT;

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "currency" TEXT DEFAULT 'AED';
