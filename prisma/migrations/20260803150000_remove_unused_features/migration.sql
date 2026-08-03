-- Remove features retired in the 2026-08 simplification pass:
--   Family Groups, Meal Ratings, Containers, Container Logs, Referrals
--
-- Stock Alerts, Profit Analytics and Sales Comparison were also removed, but
-- they were derived views over Ingredient/Order and had no tables of their own.
--
-- The Notification model is deliberately NOT dropped: only the Notification
-- Center *page* was removed. Notifications are still created by Stripe webhooks
-- and the customer portal, and are surfaced on the Dashboard.
--
-- None of these tables carry foreign keys, so ordering is not significant.

DROP TABLE IF EXISTS "ContainerLog";
DROP TABLE IF EXISTS "Container";
DROP TABLE IF EXISTS "MealRating";
DROP TABLE IF EXISTS "Referral";
DROP TABLE IF EXISTS "FamilyGroup";

-- Customer columns used only by the removed referral / family-group features.
DROP INDEX IF EXISTS "Customer_referral_code_idx";
DROP INDEX IF EXISTS "Customer_family_group_id_idx";
DROP INDEX IF EXISTS "Customer_referral_code_key";

ALTER TABLE "Customer" DROP COLUMN IF EXISTS "referral_code";
ALTER TABLE "Customer" DROP COLUMN IF EXISTS "referred_by";
ALTER TABLE "Customer" DROP COLUMN IF EXISTS "family_group_id";
