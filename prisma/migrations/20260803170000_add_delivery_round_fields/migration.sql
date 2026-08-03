-- Fields for the round-based delivery screen: record who ran the round and
-- why an individual drop failed.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "delivered_by" TEXT;
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "delivery_note" TEXT;
