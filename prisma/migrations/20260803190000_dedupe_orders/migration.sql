-- Orders were created with a read-then-write check:
--   const existing = await Order.filter({customer_id, order_date, ...});
--   if (existing.length) update; else create;
-- Two clicks, or two screens printing labels, race past that check and both
-- insert. 3,590 of 13,863 rows (25.9%) are duplicates, and the rate was rising.
--
-- This consolidates each duplicate group onto its earliest row, then adds the
-- constraint that makes the race impossible.

-- 1. Carry any delivery state from the duplicates onto the row we keep, so
--    deduping never loses a recorded delivery.
WITH ranked AS (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY created_by, customer_id, order_date, meal_type
           ORDER BY created_at, id
         ) AS keep_id
  FROM "Order"
),
consolidated AS (
  SELECT r.keep_id,
         MIN(o.lunch_delivered_at)  AS lunch_delivered_at,
         MIN(o.dinner_delivered_at) AS dinner_delivered_at,
         MIN(o.out_for_delivery_time) AS out_for_delivery_time,
         MAX(o.delivered_by)        AS delivered_by,
         BOOL_OR(o.delivery_status = 'Delivered') AS any_delivered
  FROM ranked r
  JOIN "Order" o ON o.id = r.id
  GROUP BY r.keep_id
  HAVING COUNT(*) > 1
)
UPDATE "Order" o
SET lunch_delivered_at    = COALESCE(o.lunch_delivered_at, c.lunch_delivered_at),
    dinner_delivered_at   = COALESCE(o.dinner_delivered_at, c.dinner_delivered_at),
    out_for_delivery_time = COALESCE(o.out_for_delivery_time, c.out_for_delivery_time),
    delivered_by          = COALESCE(o.delivered_by, c.delivered_by),
    delivery_status       = CASE WHEN c.any_delivered THEN 'Delivered' ELSE o.delivery_status END
FROM consolidated c
WHERE o.id = c.keep_id;

-- 2. Remove every row that is not the earliest of its group.
DELETE FROM "Order" o
USING (
  SELECT id,
         first_value(id) OVER (
           PARTITION BY created_by, customer_id, order_date, meal_type
           ORDER BY created_at, id
         ) AS keep_id
  FROM "Order"
) r
WHERE o.id = r.id AND r.id <> r.keep_id;

-- 3. Make the race impossible. One order per customer, per day, per meal plan.
CREATE UNIQUE INDEX IF NOT EXISTS "Order_customer_date_meal_key"
  ON "Order" ("created_by", "customer_id", "order_date", "meal_type");
