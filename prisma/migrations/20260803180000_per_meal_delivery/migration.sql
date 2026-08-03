-- A "Lunch + Dinner" customer is a single Order row but two physical
-- deliveries. One delivery_status could not express "lunch delivered, dinner
-- not", so each run is now stamped separately.
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "lunch_delivered_at" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "dinner_delivered_at" TIMESTAMP(3);

-- Backfill: existing rows marked Delivered had every applicable run completed.
UPDATE "Order"
SET lunch_delivered_at = COALESCE(lunch_delivered_at,
      CASE WHEN meal_type ILIKE '%lunch%' THEN COALESCE(delivery_time::timestamp, updated_at) END),
    dinner_delivered_at = COALESCE(dinner_delivered_at,
      CASE WHEN meal_type ILIKE '%dinner%' THEN COALESCE(delivery_time::timestamp, updated_at) END)
WHERE delivery_status = 'Delivered';
