-- Inventory could only ever go up: the endpoints that create ConsumptionLog
-- rows and decrement stock were never called from anywhere in the app, so
-- across 46 merchants there were 0 consumption records and Critical Stock,
-- Today's Cost and Total Consumed were permanently zero.
--
-- usage_per_tiffin lets the daily job derive consumption from the meal count
-- the app already knows, without requiring a recipe per dish (only 1 recipe
-- exists across all merchants).
ALTER TABLE "Ingredient" ADD COLUMN IF NOT EXISTS "usage_per_tiffin" DOUBLE PRECISION;
ALTER TABLE "Ingredient" ADD COLUMN IF NOT EXISTS "last_deducted_date" TEXT;
