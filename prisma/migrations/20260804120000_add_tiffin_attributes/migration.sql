-- Merchant-configurable tiffin attributes (Stage 1).
--
-- Purely additive: nothing reads these columns yet, so applying this changes no
-- behaviour. Written by hand with IF NOT EXISTS because `prisma migrate dev`
-- cannot run against this history (a pre-existing duplicate migration), and
-- because production boots with `prisma db push --accept-data-loss`, which may
-- already have created these.

CREATE TABLE IF NOT EXISTS "TiffinAttribute" (
  "id"                TEXT NOT NULL,
  "name"              TEXT NOT NULL,
  "kind"              TEXT NOT NULL,
  "choices"           JSONB,
  "default_value"     JSONB,
  "unit"              TEXT,
  "prep_category"     TEXT,
  "min_value"         INTEGER,
  "max_value"         INTEGER,
  "sort_order"        INTEGER NOT NULL DEFAULT 0,
  "is_active"         BOOLEAN NOT NULL DEFAULT true,
  "is_segment_axis"   BOOLEAN NOT NULL DEFAULT false,
  "show_on_form"      BOOLEAN NOT NULL DEFAULT true,
  "show_on_portal"    BOOLEAN NOT NULL DEFAULT true,
  "show_on_label"     BOOLEAN NOT NULL DEFAULT true,
  "show_on_kitchen"   BOOLEAN NOT NULL DEFAULT true,
  "include_in_totals" BOOLEAN NOT NULL DEFAULT true,
  "legacy_field"      TEXT,
  "created_by"        TEXT NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  CONSTRAINT "TiffinAttribute_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "TiffinAttribute_created_by_idx" ON "TiffinAttribute"("created_by");
CREATE UNIQUE INDEX IF NOT EXISTS "TiffinAttribute_created_by_legacy_field_key" ON "TiffinAttribute"("created_by", "legacy_field");

DO $$ BEGIN
  ALTER TABLE "TiffinAttribute"
    ADD CONSTRAINT "TiffinAttribute_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Per-customer values, keyed by attribute id.
ALTER TABLE "Customer"     ADD COLUMN IF NOT EXISTS "attribute_values" JSONB;
-- Snapshot at delivery time, beside the existing denormalised roti/rice copies.
ALTER TABLE "DeliveryItem" ADD COLUMN IF NOT EXISTS "attribute_values" JSONB;

-- Stable identity for prep rows; item_name stays the printed snapshot.
ALTER TABLE "PrepItem" ADD COLUMN IF NOT EXISTS "attribute_id" TEXT;
ALTER TABLE "PrepItem" ADD COLUMN IF NOT EXISTS "choice_id"    TEXT;
CREATE INDEX IF NOT EXISTS "PrepItem_prep_date_attribute_id_idx" ON "PrepItem"("prep_date", "attribute_id");
