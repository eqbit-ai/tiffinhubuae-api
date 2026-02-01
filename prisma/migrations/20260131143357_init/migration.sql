-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "full_name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'user',
    "phone" TEXT,
    "business_name" TEXT,
    "logo_url" TEXT,
    "subscription_status" TEXT DEFAULT 'trial',
    "plan_type" TEXT DEFAULT 'trial',
    "subscription_source" TEXT DEFAULT 'trial',
    "trial_ends_at" TIMESTAMP(3),
    "trial_cancelled_at" TIMESTAMP(3),
    "subscription_ends_at" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "next_billing_date" TIMESTAMP(3),
    "cancel_at_period_end" BOOLEAN DEFAULT false,
    "cancellation_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "is_paid" BOOLEAN NOT NULL DEFAULT false,
    "last_payment_status" TEXT,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "stripe_connect_account_id" TEXT,
    "payment_account_connected" BOOLEAN DEFAULT false,
    "payment_verification_status" TEXT DEFAULT 'pending',
    "fee_consent_accepted" BOOLEAN DEFAULT false,
    "fee_percentage" DOUBLE PRECISION DEFAULT 3.5,
    "whatsapp_sent_count" INTEGER NOT NULL DEFAULT 0,
    "whatsapp_limit" INTEGER NOT NULL DEFAULT 100,
    "whatsapp_notifications_enabled" BOOLEAN DEFAULT false,
    "whatsapp_number" TEXT,
    "is_super_admin" BOOLEAN NOT NULL DEFAULT false,
    "special_access_type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "phone_number" TEXT,
    "address" TEXT,
    "area" TEXT,
    "meal_type" TEXT,
    "payment_amount" DOUBLE PRECISION DEFAULT 0,
    "payment_status" TEXT DEFAULT 'Pending',
    "due_date" TIMESTAMP(3),
    "last_payment_date" TIMESTAMP(3),
    "last_payment_amount" DOUBLE PRECISION,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "status" TEXT DEFAULT 'active',
    "inactive_reason" TEXT,
    "start_date" TIMESTAMP(3),
    "end_date" TIMESTAMP(3),
    "paid_days" INTEGER DEFAULT 30,
    "delivered_days" INTEGER DEFAULT 0,
    "days_remaining" INTEGER DEFAULT 30,
    "meals_delivered" INTEGER DEFAULT 0,
    "tiffin_balance" INTEGER DEFAULT 0,
    "skip_weekends" BOOLEAN DEFAULT false,
    "pause_start" TIMESTAMP(3),
    "pause_end" TIMESTAMP(3),
    "notification_sent" BOOLEAN DEFAULT false,
    "reminder_before_sent" BOOLEAN DEFAULT false,
    "reminder_after_sent" BOOLEAN DEFAULT false,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "deleted_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "meal_type" TEXT,
    "delivery_date" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "notes" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "price" DOUBLE PRECISION DEFAULT 0,
    "category" TEXT,
    "image_url" TEXT,
    "meal_type" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "day_of_week" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TiffinSkip" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "skip_date" TEXT NOT NULL,
    "meal_type" TEXT,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "carry_forward_applied" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TiffinSkip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT,
    "read" BOOLEAN NOT NULL DEFAULT false,
    "type" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ActivityLog" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "user_name" TEXT,
    "action_type" TEXT NOT NULL,
    "entity_type" TEXT,
    "entity_id" TEXT,
    "description" TEXT,
    "metadata" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActivityLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Ingredient" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT,
    "current_stock" DOUBLE PRECISION DEFAULT 0,
    "min_stock_threshold" DOUBLE PRECISION DEFAULT 0,
    "cost_per_unit" DOUBLE PRECISION DEFAULT 0,
    "total_value" DOUBLE PRECISION DEFAULT 0,
    "is_critical" BOOLEAN NOT NULL DEFAULT false,
    "last_purchase_date" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Ingredient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "meal_type" TEXT,
    "ingredients" JSONB,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "total_cost" DOUBLE PRECISION DEFAULT 0,
    "cost_per_serving" DOUBLE PRECISION DEFAULT 0,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supplier" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "email" TEXT,
    "address" TEXT,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Purchase" (
    "id" TEXT NOT NULL,
    "ingredient_id" TEXT,
    "ingredient_name" TEXT,
    "quantity" DOUBLE PRECISION DEFAULT 0,
    "unit" TEXT,
    "cost_per_unit" DOUBLE PRECISION DEFAULT 0,
    "total_cost" DOUBLE PRECISION DEFAULT 0,
    "supplier_id" TEXT,
    "supplier_name" TEXT,
    "purchase_date" TEXT,
    "expiry_date" TEXT,
    "bill_image_url" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Purchase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Wastage" (
    "id" TEXT NOT NULL,
    "ingredient_id" TEXT NOT NULL,
    "ingredient_name" TEXT,
    "quantity" DOUBLE PRECISION DEFAULT 0,
    "unit" TEXT,
    "reason" TEXT,
    "cost_value" DOUBLE PRECISION DEFAULT 0,
    "wastage_date" TEXT,
    "notes" TEXT,
    "is_deleted" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Wastage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "message" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "priority" TEXT DEFAULT 'medium',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "plan_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "subscription_start_date" TIMESTAMP(3),
    "next_billing_date" TIMESTAMP(3),
    "current_period_end" TIMESTAMP(3),
    "amount" DOUBLE PRECISION DEFAULT 0,
    "stripe_customer_id" TEXT,
    "stripe_subscription_id" TEXT,
    "payment_method_last4" TEXT,
    "payment_method_brand" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "reminder_before_sent" BOOLEAN DEFAULT false,
    "reminder_after_sent" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentHistory" (
    "id" TEXT NOT NULL,
    "user_email" TEXT NOT NULL,
    "subscription_id" TEXT,
    "amount" DOUBLE PRECISION DEFAULT 0,
    "currency" TEXT DEFAULT 'AED',
    "status" TEXT,
    "payment_date" TIMESTAMP(3),
    "stripe_payment_id" TEXT,
    "payment_method_last4" TEXT,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentLink" (
    "id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "customer_name" TEXT,
    "amount" DOUBLE PRECISION DEFAULT 0,
    "currency" TEXT DEFAULT 'AED',
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stripe_checkout_session_id" TEXT,
    "stripe_payment_intent_id" TEXT,
    "checkout_url" TEXT,
    "expires_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "platform_fee_amount" DOUBLE PRECISION DEFAULT 0,
    "net_amount" DOUBLE PRECISION DEFAULT 0,
    "payment_metadata" JSONB,
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PaymentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConsumptionLog" (
    "id" TEXT NOT NULL,
    "date" TEXT,
    "recipe_id" TEXT,
    "recipe_name" TEXT,
    "meal_type" TEXT,
    "quantity_prepared" INTEGER DEFAULT 0,
    "ingredients_used" JSONB,
    "total_cost" DOUBLE PRECISION DEFAULT 0,
    "cost_per_meal" DOUBLE PRECISION DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConsumptionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Customer_created_by_idx" ON "Customer"("created_by");

-- CreateIndex
CREATE INDEX "Customer_is_deleted_idx" ON "Customer"("is_deleted");

-- CreateIndex
CREATE INDEX "Order_created_by_idx" ON "Order"("created_by");

-- CreateIndex
CREATE INDEX "Order_customer_id_idx" ON "Order"("customer_id");

-- CreateIndex
CREATE INDEX "Order_delivery_date_idx" ON "Order"("delivery_date");

-- CreateIndex
CREATE INDEX "MenuItem_created_by_idx" ON "MenuItem"("created_by");

-- CreateIndex
CREATE INDEX "TiffinSkip_created_by_idx" ON "TiffinSkip"("created_by");

-- CreateIndex
CREATE INDEX "TiffinSkip_customer_id_idx" ON "TiffinSkip"("customer_id");

-- CreateIndex
CREATE INDEX "TiffinSkip_skip_date_idx" ON "TiffinSkip"("skip_date");

-- CreateIndex
CREATE INDEX "Notification_user_email_idx" ON "Notification"("user_email");

-- CreateIndex
CREATE INDEX "ActivityLog_user_email_idx" ON "ActivityLog"("user_email");

-- CreateIndex
CREATE INDEX "ActivityLog_created_by_idx" ON "ActivityLog"("created_by");

-- CreateIndex
CREATE INDEX "Ingredient_created_by_idx" ON "Ingredient"("created_by");

-- CreateIndex
CREATE INDEX "Recipe_created_by_idx" ON "Recipe"("created_by");

-- CreateIndex
CREATE INDEX "Supplier_created_by_idx" ON "Supplier"("created_by");

-- CreateIndex
CREATE INDEX "Purchase_created_by_idx" ON "Purchase"("created_by");

-- CreateIndex
CREATE INDEX "Wastage_created_by_idx" ON "Wastage"("created_by");

-- CreateIndex
CREATE INDEX "SupportTicket_user_email_idx" ON "SupportTicket"("user_email");

-- CreateIndex
CREATE INDEX "Subscription_user_email_idx" ON "Subscription"("user_email");

-- CreateIndex
CREATE INDEX "Subscription_stripe_subscription_id_idx" ON "Subscription"("stripe_subscription_id");

-- CreateIndex
CREATE INDEX "PaymentHistory_user_email_idx" ON "PaymentHistory"("user_email");

-- CreateIndex
CREATE INDEX "PaymentLink_created_by_idx" ON "PaymentLink"("created_by");

-- CreateIndex
CREATE INDEX "PaymentLink_customer_id_idx" ON "PaymentLink"("customer_id");

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TiffinSkip" ADD CONSTRAINT "TiffinSkip_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TiffinSkip" ADD CONSTRAINT "TiffinSkip_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActivityLog" ADD CONSTRAINT "ActivityLog_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Ingredient" ADD CONSTRAINT "Ingredient_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Supplier" ADD CONSTRAINT "Supplier_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Purchase" ADD CONSTRAINT "Purchase_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wastage" ADD CONSTRAINT "Wastage_ingredient_id_fkey" FOREIGN KEY ("ingredient_id") REFERENCES "Ingredient"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Wastage" ADD CONSTRAINT "Wastage_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentLink" ADD CONSTRAINT "PaymentLink_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
