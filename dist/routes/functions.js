"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.runAutoPaymentReminders = runAutoPaymentReminders;
exports.runTrialExpiryCheck = runTrialExpiryCheck;
exports.runMealRatingRequests = runMealRatingRequests;
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const email_1 = require("../services/email");
const whatsapp_1 = require("../services/whatsapp");
const stripe_1 = require("../services/stripe");
const date_fns_1 = require("date-fns");
const router = (0, express_1.Router)();
// All routes require auth
router.use(auth_1.authMiddleware);
// ─── Record Delivery ──────────────────────────────────────────
router.post('/record-delivery', async (req, res) => {
    try {
        const user = req.user;
        const { customerId, orderDate } = req.body;
        if (!customerId || !orderDate) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, is_deleted: false },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found or access denied' });
        // Check if date is skipped
        const skips = await prisma_1.prisma.tiffinSkip.findMany({
            where: { customer_id: customerId, created_by: user.id, skip_date: orderDate, status: 'active' },
        });
        if (skips.length > 0) {
            return res.status(400).json({ error: 'Cannot deliver on skipped date', skipped: true });
        }
        const newDeliveredDays = (customer.delivered_days || 0) + 1;
        const paidDays = customer.paid_days || (customer.is_trial ? 3 : 30);
        const daysRemaining = paidDays - newDeliveredDays;
        await prisma_1.prisma.customer.update({
            where: { id: customerId },
            data: {
                delivered_days: newDeliveredDays,
                days_remaining: daysRemaining,
                meals_delivered: (customer.meals_delivered || 0) + 1,
            },
        });
        if (newDeliveredDays >= paidDays) {
            await prisma_1.prisma.customer.update({
                where: { id: customerId },
                data: { active: false, notification_sent: false },
            });
            if (customer.phone_number) {
                try {
                    await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                        to: customer.phone_number,
                        message: `Your ${paidDays}-day tiffin service is complete. Please renew your subscription to continue service.`,
                    });
                }
                catch (e) { /* WhatsApp optional */ }
            }
            await (0, email_1.sendEmail)({
                to: user.email,
                subject: `Payment Due - ${customer.full_name}`,
                body: `<h2>Service Completed - Payment Required</h2>
          <p><strong>Customer:</strong> ${customer.full_name}</p>
          <p><strong>Days Delivered:</strong> ${newDeliveredDays} / ${paidDays}</p>
          <p><strong>Amount Due:</strong> AED ${customer.payment_amount}</p>`,
            });
            return res.json({ success: true, delivered_days: newDeliveredDays, service_complete: true });
        }
        res.json({ success: true, delivered_days: newDeliveredDays, days_remaining: daysRemaining });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Send WhatsApp Message ────────────────────────────────────
router.post('/send-whatsapp-message', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { message, customerId } = req.body;
        let { to } = req.body;
        if (!message) {
            return res.status(400).json({ error: 'Missing required fields: message' });
        }
        if (customerId) {
            const customer = await prisma_1.prisma.customer.findFirst({
                where: { id: customerId, created_by: user.id, is_deleted: false },
            });
            if (!customer)
                return res.status(403).json({ error: 'Customer not found or access denied' });
            if (!to) {
                to = customer.phone_number;
            }
            else if (customer.phone_number !== to) {
                return res.status(403).json({ error: 'Phone number does not match customer record' });
            }
        }
        if (!to) {
            return res.status(400).json({ error: 'Missing required fields: to (or customerId with phone number)' });
        }
        const result = await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, { to, message });
        if (!result.success && result.reason === 'Message limit reached') {
            return res.status(403).json({ error: 'Message limit reached (400). Limit resets on next billing cycle.' });
        }
        await prisma_1.prisma.activityLog.create({
            data: {
                user_email: user.email,
                user_name: user.full_name,
                action_type: 'notification_sent',
                entity_type: 'Customer',
                entity_id: customerId || null,
                description: `WhatsApp sent to ${to}`,
                metadata: { phone_number: to, message_sid: result.messageSid, customer_id: customerId },
                created_by: user.id,
            },
        });
        const updated = await prisma_1.prisma.user.findUnique({ where: { id: user.id }, select: { whatsapp_sent_count: true, whatsapp_limit: true } });
        res.json({ ...result, to, whatsapp_sent_count: updated?.whatsapp_sent_count || 0, whatsapp_limit: Math.max(updated?.whatsapp_limit || 400, 400) });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Send Payment Reminder ────────────────────────────────────
router.post('/send-payment-reminder', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        if (!customerId)
            return res.status(400).json({ error: 'Missing customerId' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, is_deleted: false },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found or deleted' });
        if (!customer.phone_number)
            return res.status(400).json({ error: 'Customer has no phone number' });
        const currency = user.currency || 'AED';
        const message = `Payment Reminder\n\nHello ${customer.full_name},\n\nYour payment is ${customer.payment_status === 'Overdue' ? 'overdue' : 'due'}.\n\nAmount Due: ${currency} ${customer.payment_amount}\n${customer.due_date ? `Due Date: ${new Date(customer.due_date).toLocaleDateString('en-GB')}` : ''}\n\nPlease make the payment to continue your tiffin service.\n\nThank you!`;
        await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
            to: customer.phone_number,
            message,
            templateName: 'PAYMENT_REMINDER',
            contentVariables: { 'customer name': customer.full_name || 'Customer', 'currency ': currency, 'amount': String(customer.payment_amount || 0) },
        });
        await (0, email_1.sendEmail)({
            to: user.email,
            subject: `Payment Reminder Sent - ${customer.full_name}`,
            body: `<h2>Payment Reminder Sent</h2><p><strong>Customer:</strong> ${customer.full_name}</p><p><strong>Amount:</strong> AED ${customer.payment_amount}</p>`,
        });
        res.json({ success: true, message: 'Payment reminder sent successfully' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Send Bulk Payment Reminders ──────────────────────────────
router.post('/send-bulk-payment-reminders', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { customerIds } = req.body;
        if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
            return res.status(400).json({ error: 'No customer IDs provided' });
        }
        const customers = await prisma_1.prisma.customer.findMany({
            where: { id: { in: customerIds }, created_by: user.id, is_deleted: false, active: true },
        });
        let sentCount = 0;
        const errors = [];
        const skipped = [];
        for (const customer of customers) {
            if (!customer.phone_number) {
                skipped.push({ customer: customer.full_name, reason: 'No phone number' });
                continue;
            }
            try {
                const bulkCurrency = user.currency || 'AED';
                const message = `Payment Reminder\n\nDear ${customer.full_name},\n\nYour tiffin subscription expires in ${customer.days_remaining} days.\n\nAmount Due: ${bulkCurrency} ${customer.payment_amount}\n\nPlease renew your subscription.\n\nThank you!`;
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message,
                    templateName: 'PAYMENT_REMINDER',
                    contentVariables: { 'customer name': customer.full_name || 'Customer', 'currency ': bulkCurrency, 'amount': String(customer.payment_amount || 0) },
                });
                sentCount++;
            }
            catch (error) {
                errors.push({ customer: customer.full_name, error: error.message });
            }
        }
        res.json({ sent: sentCount, skipped: skipped.length, total: customers.length, errors: errors.length > 0 ? errors : undefined });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Create Checkout Session (platform subscription) ──────────
router.post('/create-checkout-session', async (req, res) => {
    try {
        const user = req.user;
        const { priceId } = req.body;
        if (!priceId)
            return res.status(400).json({ error: 'Price ID is required' });
        if (stripe_1.STRIPE_PREMIUM_PRICE_ID && priceId !== stripe_1.STRIPE_PREMIUM_PRICE_ID) {
            return res.status(400).json({ error: 'Invalid price ID' });
        }
        const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
        const appUrl = origin.replace(/\/$/, '');
        const session = await stripe_1.stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            customer_email: user.email,
            client_reference_id: user.id,
            metadata: { user_id: user.id, user_email: user.email },
            success_url: `${appUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/PaymentCancelled?session_id={CHECKOUT_SESSION_ID}`,
        });
        res.json({ url: session.url });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Cancel Subscription ─────────────────────────────────────
router.post('/cancel-subscription', async (req, res) => {
    try {
        const user = req.user;
        const { reason } = req.body;
        if (!user.stripe_subscription_id) {
            return res.status(400).json({ error: 'No active subscription found' });
        }
        const subscription = await stripe_1.stripe.subscriptions.update(user.stripe_subscription_id, {
            cancel_at_period_end: true,
        });
        const accessEndsAt = new Date(subscription.current_period_end * 1000).toISOString();
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                subscription_status: 'cancelled',
                plan_type: 'none',
                subscription_ends_at: new Date(accessEndsAt),
                current_period_end: new Date(accessEndsAt),
                cancel_at_period_end: true,
                cancellation_reason: reason || 'No reason provided',
                cancelled_at: new Date(),
                is_paid: false,
            },
        });
        const subs = await prisma_1.prisma.subscription.findMany({ where: { user_email: user.email } });
        if (subs.length > 0) {
            await prisma_1.prisma.subscription.update({
                where: { id: subs[0].id },
                data: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason || 'No reason provided' },
            });
        }
        res.json({ success: true, access_until: accessEndsAt, status: 'cancelled' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Check Low Stock ──────────────────────────────────────────
router.post('/check-low-stock', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const allIngredients = await prisma_1.prisma.ingredient.findMany({ where: { created_by: user.id } });
        const criticalStock = allIngredients.filter(i => (i.current_stock || 0) <= (i.min_stock_threshold || 0));
        if (criticalStock.length === 0) {
            return res.json({ success: true, critical_count: 0, message: 'All ingredients are well stocked' });
        }
        try {
            await (0, email_1.sendEmail)({
                to: user.email,
                subject: '⚠️ Low Stock Alert - TiffinHub',
                body: `<h2>Low Stock Alert</h2><ul>${criticalStock.map(i => `<li><strong>${i.name}</strong>: ${i.current_stock} ${i.unit} (Min: ${i.min_stock_threshold})</li>`).join('')}</ul>`,
            });
        }
        catch (e) {
            console.error('[Functions] Send failed:', e.message);
        }
        res.json({ success: true, critical_count: criticalStock.length, critical_items: criticalStock });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Batch Cooking ────────────────────────────────────────────
router.post('/batch-cooking', async (req, res) => {
    try {
        const user = req.user;
        const { meal_type, quantity } = req.body;
        if (!meal_type || !quantity)
            return res.status(400).json({ error: 'meal_type and quantity required' });
        const recipe = await prisma_1.prisma.recipe.findFirst({
            where: { meal_type, is_active: true, created_by: user.id },
        });
        if (!recipe)
            return res.status(404).json({ error: `No active recipe found for ${meal_type}` });
        const ingredients = recipe.ingredients || [];
        const deductions = [];
        let totalCost = 0;
        for (const ing of ingredients) {
            const current = await prisma_1.prisma.ingredient.findUnique({ where: { id: ing.ingredient_id } });
            if (current) {
                const totalQty = ing.quantity * quantity;
                const newStock = (current.current_stock || 0) - totalQty;
                const cost = totalQty * (current.cost_per_unit || 0);
                totalCost += cost;
                await prisma_1.prisma.ingredient.update({
                    where: { id: current.id },
                    data: {
                        current_stock: Math.max(0, newStock),
                        is_critical: newStock <= (current.min_stock_threshold || 0),
                        total_value: newStock * (current.cost_per_unit || 0),
                    },
                });
                deductions.push({ ingredient: ing.ingredient_name, deducted: totalQty, unit: ing.unit, remaining: Math.max(0, newStock), cost });
            }
        }
        await prisma_1.prisma.consumptionLog.create({
            data: {
                date: new Date().toISOString().split('T')[0],
                recipe_id: recipe.id,
                recipe_name: recipe.name,
                meal_type: recipe.meal_type,
                quantity_prepared: quantity,
                ingredients_used: recipe.ingredients || undefined,
                total_cost: totalCost,
                cost_per_meal: totalCost / quantity,
            },
        });
        res.json({ success: true, batch_details: { meal_type, quantity, total_cost: totalCost, cost_per_meal: totalCost / quantity }, deductions });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Apply Tiffin Carry Forward ───────────────────────────────
router.post('/apply-tiffin-carry-forward', async (req, res) => {
    try {
        const user = req.user;
        const currentMonth = (0, date_fns_1.format)(new Date(), 'yyyy-MM');
        const customers = await prisma_1.prisma.customer.findMany({ where: { created_by: user.id, is_deleted: false } });
        let processedCount = 0;
        let totalDaysApplied = 0;
        for (const customer of customers) {
            const skips = await prisma_1.prisma.tiffinSkip.findMany({
                where: { customer_id: customer.id, carry_forward_applied: false, status: 'active' },
            });
            const skipsThisMonth = skips.filter(s => s.skip_date.startsWith(currentMonth));
            if (skipsThisMonth.length > 0) {
                const mealType = customer.meal_type || 'Lunch';
                let mealsPerDay = 0;
                if (mealType.includes('Breakfast'))
                    mealsPerDay++;
                if (mealType.includes('Lunch'))
                    mealsPerDay++;
                if (mealType.includes('Dinner'))
                    mealsPerDay++;
                if (mealsPerDay === 0)
                    mealsPerDay = 1;
                const daysToAdd = Math.floor(skipsThisMonth.length / mealsPerDay);
                const remainingMeals = skipsThisMonth.length % mealsPerDay;
                const currentEndDate = customer.end_date ? new Date(customer.end_date) : new Date();
                const newEndDate = (0, date_fns_1.addDays)(currentEndDate, daysToAdd);
                await prisma_1.prisma.customer.update({
                    where: { id: customer.id },
                    data: { end_date: newEndDate, tiffin_balance: (customer.tiffin_balance || 0) + remainingMeals },
                });
                for (const skip of skipsThisMonth) {
                    await prisma_1.prisma.tiffinSkip.update({
                        where: { id: skip.id },
                        data: { carry_forward_applied: true, status: 'applied' },
                    });
                }
                processedCount++;
                totalDaysApplied += skipsThisMonth.length;
            }
        }
        res.json({ success: true, processed: processedCount, totalDaysApplied });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Delete Customer (soft) ──────────────────────────────────
router.post('/delete-customer', async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        if (!customerId)
            return res.status(400).json({ error: 'Customer ID is required' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found or access denied' });
        await prisma_1.prisma.customer.update({
            where: { id: customerId },
            data: { is_deleted: true, deleted_at: new Date() },
        });
        await prisma_1.prisma.activityLog.create({
            data: {
                user_email: user.email,
                user_name: user.full_name,
                action_type: 'customer_deleted',
                entity_type: 'Customer',
                entity_id: customerId,
                description: `Deleted customer: ${customer.full_name}`,
                metadata: { customer_name: customer.full_name, phone_number: customer.phone_number },
                created_by: user.id,
            },
        });
        res.json({ success: true, message: 'Customer deleted successfully', customerId });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Clear Deleted Customers (hard delete) ────────────────────
router.post('/clear-deleted-customers', async (req, res) => {
    try {
        const user = req.user;
        const result = await prisma_1.prisma.customer.deleteMany({
            where: { created_by: user.id, is_deleted: true },
        });
        res.json({ success: true, deleted: result.count });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Add Purchase ─────────────────────────────────────────────
router.post('/add-purchase', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { ingredient_id, quantity, cost_per_unit, supplier_id, purchase_date, expiry_date, notes } = req.body;
        if (!ingredient_id || !quantity)
            return res.status(400).json({ error: 'ingredient_id and quantity required' });
        const ingredient = await prisma_1.prisma.ingredient.findUnique({ where: { id: ingredient_id } });
        if (!ingredient)
            return res.status(404).json({ error: 'Ingredient not found' });
        let supplier_name = null;
        if (supplier_id) {
            const supplier = await prisma_1.prisma.supplier.findUnique({ where: { id: supplier_id } });
            supplier_name = supplier?.name || null;
        }
        const effectiveCost = cost_per_unit || ingredient.cost_per_unit || 0;
        const purchase = await prisma_1.prisma.purchase.create({
            data: {
                ingredient_id,
                ingredient_name: ingredient.name,
                quantity,
                unit: ingredient.unit,
                cost_per_unit: effectiveCost,
                total_cost: quantity * effectiveCost,
                supplier_id: supplier_id || null,
                supplier_name,
                purchase_date: purchase_date || new Date().toISOString().split('T')[0],
                expiry_date: expiry_date || null,
                notes: notes || null,
                created_by: user.id,
            },
        });
        const newStock = (ingredient.current_stock || 0) + quantity;
        await prisma_1.prisma.ingredient.update({
            where: { id: ingredient_id },
            data: {
                current_stock: newStock,
                cost_per_unit: effectiveCost,
                total_value: newStock * effectiveCost,
                is_critical: newStock <= (ingredient.min_stock_threshold || 0),
                last_purchase_date: new Date().toISOString().split('T')[0],
            },
        });
        res.json({ success: true, purchase, message: `Added ${quantity} ${ingredient.unit} of ${ingredient.name} to stock` });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Add Wastage ──────────────────────────────────────────────
router.post('/add-wastage', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { ingredient_id, quantity, reason, notes } = req.body;
        if (!ingredient_id || !quantity || !reason) {
            return res.status(400).json({ error: 'ingredient_id, quantity, and reason required' });
        }
        const ingredient = await prisma_1.prisma.ingredient.findUnique({ where: { id: ingredient_id } });
        if (!ingredient)
            return res.status(404).json({ error: 'Ingredient not found' });
        const costValue = quantity * (ingredient.cost_per_unit || 0);
        const wastage = await prisma_1.prisma.wastage.create({
            data: {
                ingredient_id,
                ingredient_name: ingredient.name,
                quantity,
                unit: ingredient.unit,
                reason,
                cost_value: costValue,
                wastage_date: new Date().toISOString().split('T')[0],
                notes: notes || '',
                created_by: user.id,
            },
        });
        const newStock = Math.max(0, (ingredient.current_stock || 0) - quantity);
        await prisma_1.prisma.ingredient.update({
            where: { id: ingredient_id },
            data: {
                current_stock: newStock,
                total_value: newStock * (ingredient.cost_per_unit || 0),
                is_critical: newStock <= (ingredient.min_stock_threshold || 0),
            },
        });
        res.json({ success: true, wastage, message: `Logged wastage: ${quantity} ${ingredient.unit} of ${ingredient.name}` });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Deduct Inventory ─────────────────────────────────────────
router.post('/deduct-inventory', async (req, res) => {
    try {
        const user = req.user;
        const { recipe_id, quantity } = req.body;
        if (!recipe_id || !quantity)
            return res.status(400).json({ error: 'recipe_id and quantity required' });
        const recipe = await prisma_1.prisma.recipe.findFirst({
            where: { id: recipe_id, created_by: user.id },
        });
        if (!recipe)
            return res.status(404).json({ error: 'Recipe not found or access denied' });
        const ingredients = recipe.ingredients || [];
        const deductions = [];
        for (const ing of ingredients) {
            const current = await prisma_1.prisma.ingredient.findFirst({
                where: { id: ing.ingredient_id, created_by: user.id },
            });
            if (current) {
                const totalQty = ing.quantity * quantity;
                const newStock = (current.current_stock || 0) - totalQty;
                await prisma_1.prisma.ingredient.update({
                    where: { id: current.id },
                    data: {
                        current_stock: Math.max(0, newStock),
                        is_critical: newStock <= (current.min_stock_threshold || 0),
                        total_value: newStock * (current.cost_per_unit || 0),
                    },
                });
                deductions.push({ ingredient: ing.ingredient_name, deducted: totalQty, remaining: Math.max(0, newStock) });
            }
        }
        await prisma_1.prisma.consumptionLog.create({
            data: {
                date: new Date().toISOString().split('T')[0],
                recipe_id: recipe.id,
                recipe_name: recipe.name,
                meal_type: recipe.meal_type,
                quantity_prepared: quantity,
                ingredients_used: recipe.ingredients || undefined,
                total_cost: (recipe.total_cost || 0) * quantity,
                cost_per_meal: recipe.cost_per_serving,
            },
        });
        res.json({ success: true, deductions });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Should Deliver Today ─────────────────────────────────────
router.post('/should-deliver-today', async (req, res) => {
    try {
        const user = req.user;
        const { customerId, date } = req.body;
        if (!customerId || !date)
            return res.status(400).json({ error: 'Missing required fields' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, is_deleted: false },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found or access denied' });
        if (!customer.active)
            return res.json({ shouldDeliver: false, reason: 'Service inactive' });
        if ((customer.delivered_days || 0) >= (customer.paid_days || 30)) {
            return res.json({ shouldDeliver: false, reason: 'All paid days delivered' });
        }
        const checkDate = new Date(date);
        if (customer.start_date && checkDate < new Date(customer.start_date)) {
            return res.json({ shouldDeliver: false, reason: 'Before service start date' });
        }
        if (customer.status === 'paused' && customer.pause_start && customer.pause_end) {
            if (checkDate >= new Date(customer.pause_start) && checkDate <= new Date(customer.pause_end)) {
                return res.json({ shouldDeliver: false, reason: 'Service paused' });
            }
        }
        const skips = await prisma_1.prisma.tiffinSkip.findMany({
            where: { customer_id: customerId, created_by: user.id, skip_date: date, status: 'active' },
        });
        if (skips.length > 0)
            return res.json({ shouldDeliver: false, reason: 'Date is skipped' });
        const dayOfWeek = checkDate.getDay();
        if (customer.skip_weekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
            return res.json({ shouldDeliver: false, reason: 'Weekend skip enabled' });
        }
        res.json({ shouldDeliver: true, customer });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Calculate End Date ───────────────────────────────────────
router.post('/calculate-end-date', async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        if (!customerId)
            return res.status(400).json({ error: 'Customer ID required' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, is_deleted: false },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found or access denied' });
        const skips = await prisma_1.prisma.tiffinSkip.findMany({
            where: { customer_id: customerId, created_by: user.id, status: 'active' },
        });
        const skipDates = new Set(skips.map(s => s.skip_date));
        let currentDate = customer.start_date ? new Date(customer.start_date) : new Date();
        let deliveredCount = 0;
        const paidDays = customer.paid_days || 30;
        while (deliveredCount < paidDays) {
            const dateStr = currentDate.toISOString().split('T')[0];
            const isSkipped = skipDates.has(dateStr);
            const isWeekend = currentDate.getDay() === 0 || currentDate.getDay() === 6;
            const skipWeekend = customer.skip_weekends && isWeekend;
            if (!isSkipped && !skipWeekend)
                deliveredCount++;
            currentDate.setDate(currentDate.getDate() + 1);
        }
        currentDate.setDate(currentDate.getDate() - 1);
        const endDate = currentDate.toISOString().split('T')[0];
        await prisma_1.prisma.customer.update({
            where: { id: customerId },
            data: { end_date: currentDate, days_remaining: paidDays - (customer.delivered_days || 0) },
        });
        res.json({ success: true, endDate, totalSkips: skipDates.size });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Initialize New User ──────────────────────────────────────
router.post('/initialize-new-user', async (req, res) => {
    try {
        const user = req.user;
        if (user.subscription_status) {
            return res.json({ message: 'User already initialized', status: user.subscription_status });
        }
        const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                subscription_status: 'trial',
                plan_type: 'trial',
                subscription_source: 'trial',
                trial_ends_at: trialEndsAt,
                is_paid: false,
            },
        });
        res.json({ success: true, trial_ends_at: trialEndsAt.toISOString(), status: 'trial' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Check Subscription Status ────────────────────────────────
router.post('/check-subscription-status', async (req, res) => {
    try {
        const user = req.user;
        const subs = await prisma_1.prisma.subscription.findMany({ where: { user_email: user.email } });
        if (!subs.length)
            return res.json({ hasSubscription: false, status: 'no_subscription' });
        const sub = subs[0];
        if (sub.stripe_subscription_id) {
            try {
                const stripeSub = await stripe_1.stripe.subscriptions.retrieve(sub.stripe_subscription_id);
                const status = stripeSub.status;
                await prisma_1.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        subscription_status: status,
                        plan_type: 'premium',
                        is_paid: status === 'active',
                        current_period_end: new Date(stripeSub.current_period_end * 1000),
                        last_payment_status: status === 'active' ? 'succeeded' : status,
                    },
                });
                return res.json({ hasSubscription: true, status, planType: 'premium', isActive: status === 'active' });
            }
            catch {
                return res.json({ hasSubscription: true, status: sub.status, error: 'Could not verify with Stripe' });
            }
        }
        res.json({ hasSubscription: true, status: sub.status });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Check Premium Access ─────────────────────────────────────
router.post('/check-premium-access', async (req, res) => {
    const user = req.user;
    const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
    const isSuperAdmin = user.email === DEFAULT_SUPER_ADMIN || user.is_super_admin;
    const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
    const hasPremium = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';
    res.json({ hasPremiumAccess: hasPremium, plan_type: user.plan_type, subscription_status: user.subscription_status });
});
// ─── Check Plan Access ────────────────────────────────────────
router.post('/check-plan-access', async (req, res) => {
    const user = req.user;
    const { feature } = req.body;
    const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
    const isSuperAdmin = user.email === DEFAULT_SUPER_ADMIN || user.is_super_admin;
    const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
    const hasPremium = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';
    res.json({ hasAccess: hasPremium, feature, plan_type: user.plan_type });
});
// ─── Check Trial Expiry ──────────────────────────────────────
router.post('/check-trial-expiry', async (req, res) => {
    const user = req.user;
    if (user.subscription_status !== 'trial' || !user.trial_ends_at) {
        return res.json({ isExpired: false, status: user.subscription_status });
    }
    const isExpired = new Date() > new Date(user.trial_ends_at);
    if (isExpired) {
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: { subscription_status: 'expired', plan_type: 'none' },
        });
    }
    res.json({ isExpired, trial_ends_at: user.trial_ends_at, status: isExpired ? 'expired' : 'trial' });
});
// ─── Get Effective Plan ───────────────────────────────────────
router.post('/get-effective-plan', async (req, res) => {
    const user = req.user;
    res.json({
        plan_type: user.plan_type,
        subscription_status: user.subscription_status,
        subscription_source: user.subscription_source,
        trial_ends_at: user.trial_ends_at,
        subscription_ends_at: user.subscription_ends_at,
    });
});
// ─── List Active Plans ────────────────────────────────────────
router.post('/list-active-plans', async (_req, res) => {
    try {
        // Try fetching real prices from Stripe
        if (stripe_1.STRIPE_PREMIUM_PRICE_ID && process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
            try {
                const prices = await stripe_1.stripe.prices.list({ active: true, limit: 10, expand: ['data.product'] });
                const filtered = stripe_1.STRIPE_PREMIUM_PRICE_ID
                    ? prices.data.filter(p => p.id === stripe_1.STRIPE_PREMIUM_PRICE_ID)
                    : prices.data;
                return res.json({ prices: filtered });
            }
            catch (e) {
                console.log('[list-active-plans] Stripe fetch failed:', e.message);
            }
        }
        // Fallback: return hardcoded plan in Stripe-compatible format
        res.json({
            prices: [
                {
                    id: stripe_1.STRIPE_PREMIUM_PRICE_ID || 'price_premium',
                    unit_amount: 6999,
                    currency: 'aed',
                    recurring: { interval: 'month' },
                    product: { name: 'Premium Plan' },
                },
            ],
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Reset WhatsApp Cycle ─────────────────────────────────────
router.post('/reset-whatsapp-cycle', async (req, res) => {
    const user = req.user;
    await prisma_1.prisma.user.update({ where: { id: user.id }, data: { whatsapp_sent_count: 0 } });
    res.json({ success: true });
});
// ─── Send Customer Payment Reminder ───────────────────────────
router.post('/send-customer-payment-reminder', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, is_deleted: false },
        });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        if (!customer.phone_number)
            return res.status(400).json({ error: 'No phone number' });
        const cCurrency = user.currency || 'AED';
        const message = `Payment Reminder\n\nHello ${customer.full_name},\n\nYour payment of ${cCurrency} ${customer.payment_amount} is due.\n\nPlease make the payment to continue service.\n\nThank you!`;
        const result = await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
            to: customer.phone_number,
            message,
            templateName: 'PAYMENT_REMINDER',
            contentVariables: { 'customer name': customer.full_name || 'Customer', 'currency ': cCurrency, 'amount': String(customer.payment_amount || 0) },
        });
        if (!result.success && result.reason === 'Message limit reached') {
            return res.status(403).json({ error: 'Message limit reached (400). Limit resets on next billing cycle.' });
        }
        res.json({ success: true, message: 'Reminder sent' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Send Customer Email ──────────────────────────────────────
router.post('/send-customer-email', async (req, res) => {
    try {
        const { to, subject, body } = req.body;
        if (!to || !subject || !body)
            return res.status(400).json({ error: 'to, subject, body required' });
        const result = await (0, email_1.sendEmail)({ to, subject, body });
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Assign User Plan (Super Admin) ──────────────────────────
router.post('/assign-user-plan', auth_1.superAdminOnly, async (req, res) => {
    try {
        const { targetUserEmail, planType, durationMonths } = req.body;
        if (!targetUserEmail || !planType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        if (!['basic', 'premium'].includes(planType)) {
            return res.status(400).json({ error: 'Invalid plan type' });
        }
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email: targetUserEmail } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        const months = durationMonths || null;
        let expiryDate = null;
        if (months) {
            expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + months);
        }
        await prisma_1.prisma.user.update({
            where: { id: targetUser.id },
            data: {
                plan_type: planType,
                subscription_status: 'active',
                subscription_source: 'admin',
                is_paid: true,
                trial_ends_at: null,
                trial_cancelled_at: new Date(),
                current_period_end: expiryDate,
                subscription_ends_at: expiryDate,
                last_payment_status: 'admin_assigned',
            },
        });
        res.json({ success: true, message: `Assigned ${planType} plan to ${targetUserEmail}` });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Manual Grant Access (Super Admin) ────────────────────────
router.post('/manual-grant-access', auth_1.superAdminOnly, async (req, res) => {
    try {
        const { targetUserEmail, planType, months } = req.body;
        if (!targetUserEmail || !planType) {
            return res.status(400).json({ error: 'Missing required fields' });
        }
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email: targetUserEmail } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        let expiryDate = null;
        if (months) {
            expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + months);
        }
        await prisma_1.prisma.user.update({
            where: { id: targetUser.id },
            data: {
                plan_type: planType,
                subscription_status: 'active',
                subscription_source: 'admin',
                is_paid: true,
                current_period_end: expiryDate,
                subscription_ends_at: expiryDate,
            },
        });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Manage User (Super Admin) ────────────────────────────────
router.post('/manage-user', auth_1.superAdminOnly, async (req, res) => {
    try {
        const { targetUserEmail, action, data } = req.body;
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email: targetUserEmail } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        if (action === 'update') {
            const { password_hash: _, ...safe } = await prisma_1.prisma.user.update({ where: { id: targetUser.id }, data });
            return res.json({ success: true, user: safe });
        }
        if (action === 'delete') {
            await prisma_1.prisma.user.delete({ where: { id: targetUser.id } });
            return res.json({ success: true });
        }
        res.status(400).json({ error: 'Invalid action' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Impersonate User (Super Admin) ──────────────────────────
router.post('/impersonate-user', auth_1.superAdminOnly, async (req, res) => {
    try {
        const { targetUserEmail } = req.body;
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email: targetUserEmail } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        const { password_hash: _, ...safeUser } = targetUser;
        res.json({ success: true, user: safeUser });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Create Customer Payment Checkout ─────────────────────────
router.post('/create-customer-payment-checkout', async (req, res) => {
    try {
        const user = req.user;
        if (!user.stripe_connect_account_id || !user.payment_account_connected) {
            return res.status(403).json({ error: 'Payment account not connected', errorCode: 'PAYMENT_ACCOUNT_NOT_CONNECTED' });
        }
        if (user.payment_verification_status !== 'verified') {
            return res.status(403).json({ error: 'Payment account verification incomplete', errorCode: 'PAYMENT_ACCOUNT_NOT_VERIFIED' });
        }
        if (!user.fee_consent_accepted) {
            return res.status(403).json({ error: 'Transaction fee consent required', errorCode: 'FEE_CONSENT_REQUIRED' });
        }
        const { customerId, amount, description } = req.body;
        if (!customerId || !amount || amount <= 0) {
            return res.status(400).json({ error: 'Invalid payment details' });
        }
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: customerId, created_by: user.id } });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        const feePercentage = user.fee_percentage || 3.5;
        const platformFeeAmount = Math.round((amount * feePercentage) / 100);
        const netAmount = amount - platformFeeAmount;
        const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
        const appUrl = origin.replace(/\/$/, '');
        const session = await stripe_1.stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                    price_data: {
                        currency: 'aed',
                        product_data: { name: description || `Payment for ${customer.full_name}` },
                        unit_amount: Math.round(amount * 100),
                    },
                    quantity: 1,
                }],
            payment_intent_data: {
                application_fee_amount: Math.round(platformFeeAmount * 100),
                metadata: { customer_id: customerId, merchant_email: user.email },
            },
            metadata: { customer_id: customerId, customer_owner_email: user.email, amount: amount.toString() },
            success_url: `${appUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/PaymentCancelled?session_id={CHECKOUT_SESSION_ID}`,
        }, { stripeAccount: user.stripe_connect_account_id });
        await prisma_1.prisma.paymentLink.create({
            data: {
                customer_id: customerId,
                customer_name: customer.full_name,
                amount,
                currency: 'AED',
                description: description || `Payment for ${customer.full_name}`,
                status: 'pending',
                stripe_checkout_session_id: session.id,
                checkout_url: session.url,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                platform_fee_amount: platformFeeAmount,
                net_amount: netAmount,
                created_by: user.id,
            },
        });
        res.json({ success: true, checkoutUrl: session.url, sessionId: session.id, amount, platformFee: platformFeeAmount, netAmount });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Generate Customer Payment Link ──────────────────────────
router.post('/generate-customer-payment-link', async (req, res) => {
    try {
        const user = req.user;
        const { customerId, amount: reqAmount, description } = req.body;
        if (!user.stripe_connect_account_id || !user.payment_account_connected) {
            return res.status(403).json({ error: 'Payment account not connected' });
        }
        if (user.payment_verification_status !== 'verified') {
            return res.status(403).json({ error: 'Payment account verification incomplete' });
        }
        if (!user.fee_consent_accepted) {
            return res.status(403).json({ error: 'Transaction fee consent required' });
        }
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        const amount = reqAmount || customer.payment_amount || 0;
        if (amount <= 0)
            return res.status(400).json({ error: 'Invalid payment amount' });
        const feePercentage = user.fee_percentage || 3.5;
        const platformFeeAmount = Math.round((amount * feePercentage) / 100);
        const netAmount = amount - platformFeeAmount;
        const currencyCode = (user.currency || 'aed').toLowerCase();
        const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
        const appUrl = origin.replace(/\/$/, '');
        const session = await stripe_1.stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
                    price_data: {
                        currency: currencyCode,
                        product_data: { name: description || `Tiffin Subscription - ${customer.full_name}` },
                        unit_amount: Math.round(amount * 100),
                    },
                    quantity: 1,
                }],
            payment_intent_data: {
                application_fee_amount: Math.round(platformFeeAmount * 100),
                metadata: { customer_id: customerId, merchant_email: user.email },
            },
            metadata: {
                customer_id: customerId,
                customer_owner_email: user.email,
                ...(customer.is_trial ? { payment_type: 'trial_conversion' } : {}),
            },
            success_url: `${appUrl}/portal/payment-success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${appUrl}/portal/dashboard`,
        }, { stripeAccount: user.stripe_connect_account_id });
        await prisma_1.prisma.paymentLink.create({
            data: {
                customer_id: customerId,
                customer_name: customer.full_name,
                amount,
                currency: (user.currency || 'AED').toUpperCase(),
                description: description || `Payment for ${customer.full_name}`,
                status: 'pending',
                stripe_checkout_session_id: session.id,
                checkout_url: session.url,
                expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                platform_fee_amount: platformFeeAmount,
                net_amount: netAmount,
                created_by: user.id,
            },
        });
        // Send payment link via WhatsApp if customer has phone
        if (customer.phone_number) {
            try {
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Hello ${customer.full_name}!\n\nHere is your payment link for ${(user.currency || 'AED').toUpperCase()} ${amount}:\n${session.url}\n\nThank you!`,
                });
            }
            catch (e) {
                console.error('[Functions] WhatsApp send failed:', e.message);
            }
        }
        res.json({ success: true, checkoutUrl: session.url, sessionId: session.id, amount, platformFee: platformFeeAmount, netAmount });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Create Stripe Connect Account ───────────────────────────
router.post('/create-stripe-connect-account', async (req, res) => {
    try {
        const user = req.user;
        const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
        let accountId = user.stripe_connect_account_id;
        // If user already has a Connect account, reuse it
        if (!accountId) {
            console.log('[StripeConnect] Creating new account for', user.email);
            const account = await stripe_1.stripe.accounts.create({
                type: 'express',
                country: 'AE',
                email: user.email,
                capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
                business_type: 'company',
            });
            accountId = account.id;
            await prisma_1.prisma.user.update({
                where: { id: user.id },
                data: { stripe_connect_account_id: accountId },
            });
        }
        console.log('[StripeConnect] Creating account link for', accountId);
        const accountLink = await stripe_1.stripe.accountLinks.create({
            account: accountId,
            refresh_url: `${origin}/PaymentSetup?refresh=true`,
            return_url: `${origin}/PaymentSetup?success=true`,
            type: 'account_onboarding',
        });
        res.json({ success: true, onboardingUrl: accountLink.url, url: accountLink.url, accountId });
    }
    catch (error) {
        console.error('[StripeConnect] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
// ─── Get Stripe Account Status ───────────────────────────────
router.post('/get-stripe-account-status', async (req, res) => {
    try {
        const user = req.user;
        if (!user.stripe_connect_account_id) {
            return res.json({ connected: false });
        }
        console.log('[StripeStatus] Checking account:', user.stripe_connect_account_id);
        const account = await stripe_1.stripe.accounts.retrieve(user.stripe_connect_account_id);
        const isVerified = account.charges_enabled && account.payouts_enabled;
        const needsAction = !account.details_submitted || (account.requirements?.currently_due && account.requirements.currently_due.length > 0);
        const status = isVerified ? 'verified' : needsAction ? 'action_required' : 'pending';
        console.log('[StripeStatus] charges_enabled:', account.charges_enabled, 'payouts_enabled:', account.payouts_enabled, 'status:', status);
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                payment_account_connected: true,
                payment_verification_status: status === 'verified' ? 'verified' : 'pending',
            },
        });
        // Try to get bank account last 4 digits
        let bankAccountLast4 = null;
        try {
            const bankAccounts = await stripe_1.stripe.accounts.listExternalAccounts(account.id, { object: 'bank_account', limit: 1 });
            if (bankAccounts.data.length > 0) {
                bankAccountLast4 = bankAccounts.data[0].last4;
            }
        }
        catch { }
        res.json({
            connected: true,
            verified: isVerified,
            status,
            charges_enabled: account.charges_enabled,
            payouts_enabled: account.payouts_enabled,
            accountId: account.id,
            account_id: account.id,
            bankAccountLast4,
            feePercentage: user.fee_percentage || 3.5,
            feeConsentDate: user.fee_consent_accepted_at,
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Disconnect Payment Account ──────────────────────────────
router.post('/disconnect-payment-account', async (req, res) => {
    try {
        const user = req.user;
        await prisma_1.prisma.user.update({
            where: { id: user.id },
            data: {
                stripe_connect_account_id: null,
                payment_account_connected: false,
                payment_verification_status: 'pending',
                fee_consent_accepted: false,
            },
        });
        res.json({ success: true });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Subscription Reminders (scheduled) ──────────────────────
router.post('/subscription-reminders', async (req, res) => {
    try {
        const subs = await prisma_1.prisma.subscription.findMany({ where: { status: 'active' } });
        let sentCount = 0;
        for (const sub of subs) {
            if (!sub.current_period_end)
                continue;
            const daysUntilEnd = Math.floor((new Date(sub.current_period_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            if (daysUntilEnd === 3 && !sub.reminder_before_sent) {
                await (0, email_1.sendEmail)({
                    to: sub.user_email,
                    subject: 'Subscription Renewal Reminder - TiffinHub',
                    body: `Your TiffinHub subscription renews in 3 days on ${new Date(sub.current_period_end).toLocaleDateString()}.`,
                });
                await prisma_1.prisma.subscription.update({ where: { id: sub.id }, data: { reminder_before_sent: true } });
                sentCount++;
            }
        }
        res.json({ success: true, sent: sentCount });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Automatic Payment Reminders (scheduled) ─────────────────
async function runAutoPaymentReminders() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startOfToday = new Date(today);
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date(today);
    endOfToday.setHours(23, 59, 59, 999);
    const threeDaysAgo = new Date(today);
    threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);
    const startOfOverdueDay = new Date(threeDaysAgo);
    startOfOverdueDay.setHours(0, 0, 0, 0);
    const endOfOverdueDay = new Date(threeDaysAgo);
    endOfOverdueDay.setHours(23, 59, 59, 999);
    let beforeCount = 0;
    let afterCount = 0;
    // Find all users with active Stripe Connect
    const users = await prisma_1.prisma.user.findMany({
        where: {
            stripe_connect_account_id: { not: null },
            payment_account_connected: true,
            payment_verification_status: 'verified',
        },
    });
    const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
    for (const user of users) {
        // --- Upcoming reminders (end_date is today — last day of subscription) ---
        const upcomingCustomers = await prisma_1.prisma.customer.findMany({
            where: {
                created_by: user.id,
                is_deleted: false,
                active: true,
                end_date: { gte: startOfToday, lte: endOfToday },
                reminder_before_sent: { not: true },
                phone_number: { not: null },
            },
        });
        for (const customer of upcomingCustomers) {
            if (!customer.phone_number || !customer.payment_amount)
                continue;
            try {
                const amount = customer.payment_amount;
                const currency = user.currency || 'aed';
                const feePercentage = user.fee_percentage || 3.5;
                const platformFeeAmount = Math.round((amount * feePercentage) / 100);
                const session = await stripe_1.stripe.checkout.sessions.create({
                    mode: 'payment',
                    payment_method_types: ['card'],
                    line_items: [{
                            price_data: {
                                currency,
                                product_data: { name: 'Tiffin Subscription Renewal' },
                                unit_amount: Math.round(amount * 100),
                            },
                            quantity: 1,
                        }],
                    payment_intent_data: {
                        application_fee_amount: Math.round(platformFeeAmount * 100),
                        metadata: { customer_id: customer.id, merchant_email: user.email },
                    },
                    metadata: { customer_id: customer.id, customer_owner_email: user.email, amount: amount.toString() },
                    success_url: `${appUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${appUrl}/PaymentCancelled?session_id={CHECKOUT_SESSION_ID}`,
                }, { stripeAccount: user.stripe_connect_account_id });
                await prisma_1.prisma.paymentLink.create({
                    data: {
                        customer_id: customer.id,
                        customer_name: customer.full_name,
                        amount,
                        currency: currency.toUpperCase(),
                        description: 'Tiffin Subscription Renewal',
                        status: 'pending',
                        stripe_checkout_session_id: session.id,
                        checkout_url: session.url,
                        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                        platform_fee_amount: platformFeeAmount,
                        net_amount: amount - platformFeeAmount,
                        created_by: user.id,
                    },
                });
                const endDateFormatted = customer.end_date ? (0, date_fns_1.format)(new Date(customer.end_date), 'dd MMM yyyy') : 'N/A';
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Payment Reminder\n\nHello ${customer.full_name},\n\nYour tiffin subscription ends on ${endDateFormatted}.\n\nAmount: ${currency.toUpperCase()} ${amount}\n\nPay securely here: ${session.url}\n\nThank you!`,
                    templateName: 'PAYMENT_REMINDER_LINK',
                    contentVariables: { 'name': customer.full_name || 'Customer', 'end date': endDateFormatted, 'currency': currency.toUpperCase(), 'amount': String(amount), 'payment URL': session.url },
                });
                await prisma_1.prisma.customer.update({ where: { id: customer.id }, data: { reminder_before_sent: true } });
                beforeCount++;
            }
            catch (err) {
                console.error(`[AutoReminder] Failed for customer ${customer.id}:`, err);
            }
        }
        // --- Overdue reminders (end_date was 3 days ago) ---
        const overdueCustomers = await prisma_1.prisma.customer.findMany({
            where: {
                created_by: user.id,
                is_deleted: false,
                active: true,
                end_date: { gte: startOfOverdueDay, lte: endOfOverdueDay },
                reminder_after_sent: { not: true },
                phone_number: { not: null },
            },
        });
        for (const customer of overdueCustomers) {
            if (!customer.phone_number || !customer.payment_amount)
                continue;
            try {
                const amount = customer.payment_amount;
                const currency = user.currency || 'aed';
                const feePercentage = user.fee_percentage || 3.5;
                const platformFeeAmount = Math.round((amount * feePercentage) / 100);
                const session = await stripe_1.stripe.checkout.sessions.create({
                    mode: 'payment',
                    payment_method_types: ['card'],
                    line_items: [{
                            price_data: {
                                currency,
                                product_data: { name: 'Tiffin Subscription Renewal - Overdue' },
                                unit_amount: Math.round(amount * 100),
                            },
                            quantity: 1,
                        }],
                    payment_intent_data: {
                        application_fee_amount: Math.round(platformFeeAmount * 100),
                        metadata: { customer_id: customer.id, merchant_email: user.email },
                    },
                    metadata: { customer_id: customer.id, customer_owner_email: user.email, amount: amount.toString() },
                    success_url: `${appUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
                    cancel_url: `${appUrl}/PaymentCancelled?session_id={CHECKOUT_SESSION_ID}`,
                }, { stripeAccount: user.stripe_connect_account_id });
                await prisma_1.prisma.paymentLink.create({
                    data: {
                        customer_id: customer.id,
                        customer_name: customer.full_name,
                        amount,
                        currency: currency.toUpperCase(),
                        description: 'Tiffin Subscription Renewal - Overdue',
                        status: 'pending',
                        stripe_checkout_session_id: session.id,
                        checkout_url: session.url,
                        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                        platform_fee_amount: platformFeeAmount,
                        net_amount: amount - platformFeeAmount,
                        created_by: user.id,
                    },
                });
                const endDateFormatted = customer.end_date ? (0, date_fns_1.format)(new Date(customer.end_date), 'dd MMM yyyy') : 'N/A';
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Payment Overdue\n\nHello ${customer.full_name},\n\nYour subscription expired on ${endDateFormatted} and payment is overdue.\n\nAmount Due: ${currency.toUpperCase()} ${amount}\n\nPay now to continue: ${session.url}\n\nThank you!`,
                    templateName: 'PAYMENT_OVERDUE',
                    contentVariables: { 'name': customer.full_name || 'Customer', 'expiry date': endDateFormatted, 'currency': currency.toUpperCase(), 'amount': String(amount), 'payment URL': session.url },
                });
                await prisma_1.prisma.customer.update({
                    where: { id: customer.id },
                    data: { status: 'inactive', inactive_reason: 'non_payment', active: false, reminder_after_sent: true, payment_status: 'Overdue' },
                });
                afterCount++;
            }
            catch (err) {
                console.error(`[AutoReminder] Overdue failed for customer ${customer.id}:`, err);
            }
        }
    }
    return { success: true, beforeReminders: beforeCount, afterReminders: afterCount };
}
router.post('/automatic-payment-reminders', async (req, res) => {
    try {
        const result = await runAutoPaymentReminders();
        res.json(result);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Auto Customer Payment Reminders ─────────────────────────
router.post('/auto-customer-payment-reminders', async (req, res) => {
    // Same logic as automatic-payment-reminders, kept for backwards compatibility
    return res.json({ success: true, message: 'Use automatic-payment-reminders endpoint' });
});
// ─── Trial Expiry Check (cron) ─────────────────────────────────
async function runTrialExpiryCheck() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    // Find trial customers expiring today or already expired
    const expiringTrials = await prisma_1.prisma.customer.findMany({
        where: {
            is_trial: true,
            trial_converted: { not: true },
            active: true,
            trial_end_date: { lte: new Date() },
            phone_number: { not: null },
        },
    });
    let sentCount = 0;
    for (const customer of expiringTrials) {
        if (!customer.phone_number)
            continue;
        try {
            // Find the user who owns this customer for Stripe checkout
            const user = await prisma_1.prisma.user.findUnique({ where: { id: customer.created_by } });
            if (!user)
                continue;
            // Only premium merchants can use SMS features
            const isSuperAdmin = user.email === (process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai') || user.is_super_admin === true;
            const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
            const hasPremium = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';
            if (!hasPremium)
                continue;
            let paymentLink = '';
            if (user.stripe_connect_account_id && user.payment_account_connected && user.payment_verification_status === 'verified') {
                const amount = customer.payment_amount || 0;
                if (amount > 0) {
                    const feePercentage = user.fee_percentage || 3.5;
                    const platformFeeAmount = Math.round((amount * feePercentage) / 100);
                    const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
                    const session = await stripe_1.stripe.checkout.sessions.create({
                        mode: 'payment',
                        payment_method_types: ['card'],
                        line_items: [{
                                price_data: {
                                    currency: user.currency || 'aed',
                                    product_data: { name: 'Tiffin Subscription - Convert from Trial' },
                                    unit_amount: Math.round(amount * 100),
                                },
                                quantity: 1,
                            }],
                        payment_intent_data: {
                            application_fee_amount: Math.round(platformFeeAmount * 100),
                            metadata: { customer_id: customer.id, merchant_email: user.email },
                        },
                        metadata: { customer_id: customer.id, customer_owner_email: user.email, amount: amount.toString() },
                        success_url: `${appUrl}/PaymentSuccess?session_id={CHECKOUT_SESSION_ID}`,
                        cancel_url: `${appUrl}/PaymentCancelled?session_id={CHECKOUT_SESSION_ID}`,
                    }, { stripeAccount: user.stripe_connect_account_id });
                    paymentLink = `\n\nSubscribe now: ${session.url}`;
                }
            }
            const trialCurrency = (user.currency || 'AED').toUpperCase();
            await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                to: customer.phone_number,
                message: `Hello ${customer.full_name},\n\nYour free trial has ended! We hope you enjoyed our tiffin service.\n\nTo continue without interruption, please subscribe.\n\nAmount: ${trialCurrency} ${customer.payment_amount}/month${paymentLink}\n\nThank you!`,
            });
            // Deactivate the trial customer
            await prisma_1.prisma.customer.update({
                where: { id: customer.id },
                data: {
                    active: false,
                    status: 'inactive',
                    inactive_reason: 'trial_expired',
                    payment_status: 'Pending',
                },
            });
            // Email the merchant about this trial expiry
            if (user.email) {
                const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
                await (0, email_1.sendEmail)({
                    to: user.email,
                    subject: `Trial Ended - ${customer.full_name} needs follow-up`,
                    body: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
              <div style="background: linear-gradient(135deg, #f59e0b, #d97706); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
                <h2 style="color: white; margin: 0;">Trial Period Ended</h2>
              </div>
              <div style="background: #ffffff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
                <p style="font-size: 15px; color: #334155;">
                  <strong>${customer.full_name}</strong>'s 3-day free trial has ended and they have been deactivated.
                </p>
                <div style="background: #fffbeb; border: 1px solid #fde68a; border-radius: 8px; padding: 16px; margin: 16px 0;">
                  <p style="margin: 0 0 8px; font-size: 14px; color: #92400e;"><strong>Customer Details:</strong></p>
                  <p style="margin: 4px 0; font-size: 14px; color: #78350f;">Name: ${customer.full_name}</p>
                  ${customer.phone_number ? `<p style="margin: 4px 0; font-size: 14px; color: #78350f;">Phone: ${customer.phone_number}</p>` : ''}
                  <p style="margin: 4px 0; font-size: 14px; color: #78350f;">Amount: ${trialCurrency} ${customer.payment_amount || 0}/month</p>
                </div>
                <p style="font-size: 14px; color: #475569;">
                  ${customer.phone_number ? 'An SMS with a payment link has been sent to the customer.' : 'No phone number on file — consider reaching out manually.'}
                </p>
                <div style="text-align: center; margin: 20px 0;">
                  <a href="${appUrl}" style="background: #f59e0b; color: white; padding: 10px 28px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 15px;">
                    View Customers
                  </a>
                </div>
              </div>
            </div>
          `,
                }).catch(err => console.error(`[TrialExpiry Email] Failed for merchant ${user.email}:`, err));
            }
            sentCount++;
        }
        catch (err) {
            console.error(`[TrialExpiry] Failed for customer ${customer.id}:`, err);
        }
    }
    return { success: true, trialReminders: sentCount };
}
// ─── Send Meal Rating Request (manual) ──────────────────────────
router.post('/send-meal-rating-request', auth_1.checkPremiumAccess, async (req, res) => {
    try {
        const user = req.user;
        const { customerIds } = req.body;
        if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
            return res.status(400).json({ error: 'customerIds array required' });
        }
        const customers = await prisma_1.prisma.customer.findMany({
            where: { id: { in: customerIds }, created_by: user.id, is_deleted: false, active: true, phone_number: { not: null } },
        });
        let sentCount = 0;
        const errors = [];
        for (const customer of customers) {
            if (!customer.phone_number)
                continue;
            try {
                await prisma_1.prisma.mealRating.create({
                    data: {
                        customer_id: customer.id,
                        customer_name: customer.full_name,
                        rating: 0,
                        meal_type: customer.meal_type,
                        meal_date: (0, date_fns_1.format)(new Date(), 'yyyy-MM-dd'),
                        created_by: user.id,
                    },
                });
                const result = await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Hello ${customer.full_name},\n\nWe'd love your feedback on our tiffin service!\n\nPlease rate from 1 to 5:\n1 - Poor\n2 - Fair\n3 - Good\n4 - Very Good\n5 - Excellent\n\nReply with just the number (1-5) and any feedback.\n\nThank you!`,
                });
                if (!result.success && result.reason === 'Message limit reached') {
                    errors.push(`Message limit reached after ${sentCount} sends`);
                    break;
                }
                if (result.success)
                    sentCount++;
            }
            catch (err) {
                errors.push(`Failed for ${customer.full_name}: ${err.message}`);
            }
        }
        res.json({ success: true, sent: sentCount, errors });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Auto Meal Rating Request (kept for manual trigger only) ──────
async function runMealRatingRequests() {
    const fifteenDaysAgo = new Date();
    fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);
    // Find all active customers with phone numbers
    const customers = await prisma_1.prisma.customer.findMany({
        where: { is_deleted: false, active: true, phone_number: { not: null } },
    });
    let sentCount = 0;
    for (const customer of customers) {
        if (!customer.phone_number)
            continue;
        try {
            // Skip if we already sent a rating request in the last 15 days
            const recentRating = await prisma_1.prisma.mealRating.findFirst({
                where: {
                    customer_id: customer.id,
                    created_at: { gte: fifteenDaysAgo },
                },
            });
            if (recentRating)
                continue;
            // Create a placeholder rating entry
            await prisma_1.prisma.mealRating.create({
                data: {
                    customer_id: customer.id,
                    customer_name: customer.full_name,
                    rating: 0,
                    meal_type: customer.meal_type,
                    meal_date: (0, date_fns_1.format)(new Date(), 'yyyy-MM-dd'),
                    created_by: customer.created_by,
                },
            });
            await (0, whatsapp_1.sendMerchantWhatsApp)(customer.created_by, {
                to: customer.phone_number,
                message: `Hello ${customer.full_name},\n\nWe'd love your feedback on our tiffin service!\n\nPlease rate from 1 to 5:\n1 - Poor\n2 - Fair\n3 - Good\n4 - Very Good\n5 - Excellent\n\nReply with just the number (1-5) and any feedback.\n\nThank you!`,
            });
            sentCount++;
        }
        catch (err) {
            console.error(`[MealRating] Failed for customer ${customer.id}:`, err);
        }
    }
    return { success: true, ratingRequests: sentCount };
}
// ─── Generate Portal Link ─────────────────────────────────────
router.post('/generate-portal-link', async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        let token = customer.portal_token;
        if (!token) {
            token = require('crypto').randomBytes(24).toString('hex');
            await prisma_1.prisma.customer.update({ where: { id: customer.id }, data: { portal_token: token } });
        }
        const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
        const portalUrl = `${origin}/CustomerPortal?token=${token}`;
        res.json({ success: true, portalUrl, token });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Generate Referral Code ───────────────────────────────────
router.post('/generate-referral-code', async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        let code = customer.referral_code;
        if (!code) {
            code = customer.full_name.replace(/\s+/g, '').substring(0, 4).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
            await prisma_1.prisma.customer.update({ where: { id: customer.id }, data: { referral_code: code } });
        }
        res.json({ success: true, referralCode: code });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Apply Referral Code ──────────────────────────────────────
router.post('/apply-referral', async (req, res) => {
    try {
        const user = req.user;
        const { customerId, referralCode } = req.body;
        if (!referralCode)
            return res.status(400).json({ error: 'Referral code required' });
        const referrer = await prisma_1.prisma.customer.findFirst({
            where: { referral_code: referralCode, created_by: user.id, is_deleted: false },
        });
        if (!referrer)
            return res.status(404).json({ error: 'Invalid referral code' });
        const customer = await prisma_1.prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
        if (!customer)
            return res.status(404).json({ error: 'Customer not found' });
        if (customer.id === referrer.id)
            return res.status(400).json({ error: 'Cannot refer yourself' });
        if (customer.referred_by)
            return res.status(400).json({ error: 'Customer already has a referral' });
        await prisma_1.prisma.customer.update({ where: { id: customer.id }, data: { referred_by: referrer.id } });
        await prisma_1.prisma.referral.create({
            data: {
                referrer_id: referrer.id,
                referrer_name: referrer.full_name,
                referred_id: customer.id,
                referred_name: customer.full_name,
                referral_code: referralCode,
                status: 'completed',
                created_by: user.id,
            },
        });
        res.json({ success: true, referrer: referrer.full_name });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Approve Customer Registration ─────────────────────────────
router.post('/approve-customer', async (req, res) => {
    try {
        const user = req.user;
        const { customerId } = req.body;
        if (!customerId)
            return res.status(400).json({ error: 'Customer ID required' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, status: 'pending_verification' },
        });
        if (!customer)
            return res.status(404).json({ error: 'Pending customer not found' });
        const updateData = {
            active: true,
            status: 'active',
        };
        // If trial, set start/end dates now
        if (customer.is_trial) {
            updateData.start_date = new Date();
            updateData.end_date = (0, date_fns_1.addDays)(new Date(), 3);
            updateData.trial_end_date = (0, date_fns_1.addDays)(new Date(), 3);
            updateData.paid_days = 3;
            updateData.days_remaining = 3;
            updateData.delivered_days = 0;
            updateData.meals_delivered = 0;
        }
        await prisma_1.prisma.customer.update({ where: { id: customerId }, data: updateData });
        // Auto-generate Stripe payment link if merchant has Connect and customer has payment_amount
        let checkoutUrl = null;
        if (customer.is_trial &&
            user.stripe_connect_account_id &&
            user.payment_account_connected &&
            user.payment_verification_status === 'verified' &&
            user.fee_consent_accepted) {
            const amount = customer.payment_amount || 0;
            if (amount > 0) {
                try {
                    const feePercentage = user.fee_percentage || 3.5;
                    const platformFeeAmount = Math.round((amount * feePercentage) / 100);
                    const netAmount = amount - platformFeeAmount;
                    const unitAmount = Math.round(amount * 100); // in fils/cents
                    const currencyCode = (user.currency || 'aed').toLowerCase();
                    const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
                    const appUrl = origin.replace(/\/$/, '');
                    const session = await stripe_1.stripe.checkout.sessions.create({
                        mode: 'payment',
                        payment_method_types: ['card'],
                        line_items: [{
                                price_data: {
                                    currency: currencyCode,
                                    product_data: { name: `Tiffin Subscription - ${customer.full_name}` },
                                    unit_amount: unitAmount,
                                },
                                quantity: 1,
                            }],
                        payment_intent_data: {
                            application_fee_amount: Math.round(platformFeeAmount * 100),
                            metadata: { customer_id: customerId, merchant_email: user.email },
                        },
                        metadata: {
                            customer_id: customerId,
                            customer_owner_email: user.email,
                            payment_type: 'trial_conversion',
                        },
                        success_url: `${appUrl}/portal/payment-success?session_id={CHECKOUT_SESSION_ID}`,
                        cancel_url: `${appUrl}/portal/dashboard`,
                    }, { stripeAccount: user.stripe_connect_account_id });
                    checkoutUrl = session.url;
                    await prisma_1.prisma.paymentLink.create({
                        data: {
                            customer_id: customerId,
                            customer_name: customer.full_name,
                            amount,
                            currency: (user.currency || 'AED').toUpperCase(),
                            description: 'Trial conversion payment',
                            status: 'pending',
                            stripe_checkout_session_id: session.id,
                            checkout_url: session.url,
                            expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
                            platform_fee_amount: platformFeeAmount,
                            net_amount: netAmount,
                            created_by: user.id,
                        },
                    });
                    console.log(`[Functions] Auto-generated payment link for trial customer ${customer.full_name}`);
                }
                catch (e) {
                    console.error('[Functions] Failed to create trial payment link:', e.message);
                }
            }
        }
        // Send WhatsApp confirmation
        if (customer.phone_number) {
            try {
                const paymentMsg = checkoutUrl
                    ? `\n\nPay for your subscription here:\n${checkoutUrl}`
                    : '';
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Hello ${customer.full_name}! Your registration with ${user.business_name || 'our tiffin service'} has been approved. ${customer.is_trial ? 'Your 3-day free trial starts today!' : 'Welcome aboard!'}${paymentMsg}\n\nThank you!`,
                });
            }
            catch (e) {
                console.error('[Functions] Send failed:', e.message);
            }
        }
        res.json({ success: true, message: 'Customer approved', checkoutUrl });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Reject Customer Registration ──────────────────────────────
router.post('/reject-customer', async (req, res) => {
    try {
        const user = req.user;
        const { customerId, reason } = req.body;
        if (!customerId)
            return res.status(400).json({ error: 'Customer ID required' });
        const customer = await prisma_1.prisma.customer.findFirst({
            where: { id: customerId, created_by: user.id, status: 'pending_verification' },
        });
        if (!customer)
            return res.status(404).json({ error: 'Pending customer not found' });
        await prisma_1.prisma.customer.update({
            where: { id: customerId },
            data: { is_deleted: true, deleted_at: new Date(), status: 'rejected' },
        });
        if (customer.phone_number) {
            try {
                await (0, whatsapp_1.sendMerchantWhatsApp)(user.id, {
                    to: customer.phone_number,
                    message: `Hello ${customer.full_name}, unfortunately your registration could not be approved at this time.${reason ? ` Reason: ${reason}` : ''}\n\nPlease contact us for more information.`,
                });
            }
            catch (e) {
                console.error('[Functions] Send failed:', e.message);
            }
        }
        res.json({ success: true, message: 'Customer rejected' });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// ─── Reconcile Subscription ───────────────────────────────────
router.post('/reconcile-subscription', async (req, res) => {
    try {
        const user = req.user;
        const { userEmail } = req.body;
        const targetEmail = userEmail || user.email;
        console.log(`[Reconcile] Checking subscription for ${targetEmail}`);
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email: targetEmail } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        // Skip admin-assigned plans
        if (targetUser.subscription_source === 'admin') {
            return res.json({ success: true, message: 'Admin-assigned plan — no reconciliation needed', status: targetUser.subscription_status });
        }
        if (!targetUser.stripe_subscription_id) {
            return res.json({ success: true, message: 'No Stripe subscription on record', status: targetUser.subscription_status });
        }
        const stripeSub = await stripe_1.stripe.subscriptions.retrieve(targetUser.stripe_subscription_id);
        const stripeStatus = stripeSub.status;
        const dbStatus = targetUser.subscription_status;
        console.log(`[Reconcile] Stripe says: ${stripeStatus}, DB says: ${dbStatus}`);
        if (stripeStatus === dbStatus) {
            return res.json({ success: true, message: 'Already in sync', status: stripeStatus });
        }
        // Update DB to match Stripe
        const isActive = stripeStatus === 'active';
        await prisma_1.prisma.user.update({
            where: { id: targetUser.id },
            data: {
                subscription_status: stripeStatus,
                is_paid: isActive,
                plan_type: isActive ? 'premium' : targetUser.plan_type,
                current_period_end: new Date(stripeSub.current_period_end * 1000),
                subscription_ends_at: new Date(stripeSub.current_period_end * 1000),
                last_payment_status: isActive ? 'succeeded' : stripeStatus,
            },
        });
        // Also update subscription record if it exists
        const subs = await prisma_1.prisma.subscription.findMany({ where: { user_email: targetEmail } });
        if (subs.length > 0) {
            await prisma_1.prisma.subscription.update({
                where: { id: subs[0].id },
                data: {
                    status: stripeStatus,
                    current_period_end: new Date(stripeSub.current_period_end * 1000),
                    next_billing_date: new Date(stripeSub.current_period_end * 1000),
                },
            });
        }
        console.log(`[Reconcile] Updated ${targetEmail}: ${dbStatus} → ${stripeStatus}`);
        res.json({ success: true, message: `Reconciled: ${dbStatus} → ${stripeStatus}`, previous: dbStatus, current: stripeStatus });
    }
    catch (error) {
        console.error('[Reconcile] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
// ─── Auto Deduct Inventory on Delivery ────────────────────────
router.post('/auto-deduct-on-delivery', async (req, res) => {
    try {
        const user = req.user;
        const { orderId } = req.body;
        if (!orderId)
            return res.status(400).json({ error: 'orderId required' });
        const order = await prisma_1.prisma.order.findFirst({
            where: { id: orderId, created_by: user.id },
        });
        if (!order)
            return res.json({ success: true, skipped: true, reason: 'Order not found' });
        const mealType = order.meal_type;
        if (!mealType)
            return res.json({ success: true, skipped: true, reason: 'No meal_type on order' });
        const recipe = await prisma_1.prisma.recipe.findFirst({
            where: { meal_type: mealType, is_active: true, created_by: user.id },
        });
        if (!recipe)
            return res.json({ success: true, skipped: true, reason: `No active recipe for ${mealType}` });
        const ingredients = recipe.ingredients || [];
        const servings = recipe.servings || 1;
        const deductions = [];
        let totalCost = 0;
        for (const ing of ingredients) {
            const current = await prisma_1.prisma.ingredient.findFirst({
                where: { id: ing.ingredient_id, created_by: user.id },
            });
            if (current) {
                const deductQty = ing.quantity / servings;
                const newStock = Math.max(0, (current.current_stock || 0) - deductQty);
                const cost = deductQty * (current.cost_per_unit || 0);
                totalCost += cost;
                await prisma_1.prisma.ingredient.update({
                    where: { id: current.id },
                    data: {
                        current_stock: newStock,
                        total_value: newStock * (current.cost_per_unit || 0),
                        is_critical: newStock <= (current.min_stock_threshold || 0),
                    },
                });
                deductions.push({ ingredient: ing.ingredient_name, deducted: deductQty, unit: ing.unit, remaining: newStock });
            }
        }
        await prisma_1.prisma.consumptionLog.create({
            data: {
                date: new Date().toISOString().split('T')[0],
                recipe_id: recipe.id,
                recipe_name: recipe.name,
                meal_type: recipe.meal_type,
                quantity_prepared: 1,
                ingredients_used: recipe.ingredients || undefined,
                total_cost: totalCost,
                cost_per_meal: totalCost,
            },
        });
        res.json({ success: true, deductions });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=functions.js.map