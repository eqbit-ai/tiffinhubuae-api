-- Globalization: Add timezone, country fields to User
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "timezone" TEXT DEFAULT 'UTC';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "country" TEXT;

-- White-label branding fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "brand_primary_color" TEXT DEFAULT '#6366f1';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "brand_accent_color" TEXT DEFAULT '#f97316';
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "custom_domain" TEXT;

-- Change default currency from AED to USD for new records
ALTER TABLE "User" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "PaymentHistory" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "PaymentLink" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "Invoice" ALTER COLUMN "currency" SET DEFAULT 'USD';
ALTER TABLE "OneTimeOrder" ALTER COLUMN "currency" SET DEFAULT 'USD';
