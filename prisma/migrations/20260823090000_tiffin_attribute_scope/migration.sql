-- Per-meal tiffin values.
-- 'customer' keeps every existing attribute behaving exactly as before; only an
-- attribute a merchant marks 'per_meal' offers the per-meal editor on the form.
ALTER TABLE "TiffinAttribute" ADD COLUMN "scope" TEXT NOT NULL DEFAULT 'customer';
