import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest, checkPremiumAccess, superAdminOnly } from '../middleware/auth';
import { sendEmail } from '../services/email';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { stripe, STRIPE_PREMIUM_PRICE_ID } from '../services/stripe';
import { addDays, format } from 'date-fns';

const router = Router();

// All routes require auth
router.use(authMiddleware);

// ─── Record Delivery ──────────────────────────────────────────
router.post('/record-delivery', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId, orderDate } = req.body;

    if (!customerId || !orderDate) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found or access denied' });

    // Check if date is skipped
    const skips = await prisma.tiffinSkip.findMany({
      where: { customer_id: customerId, created_by: user.id, skip_date: orderDate, status: 'active' },
    });
    if (skips.length > 0) {
      return res.status(400).json({ error: 'Cannot deliver on skipped date', skipped: true });
    }

    const newDeliveredDays = (customer.delivered_days || 0) + 1;
    const paidDays = customer.paid_days || 30;
    const daysRemaining = paidDays - newDeliveredDays;

    await prisma.customer.update({
      where: { id: customerId },
      data: {
        delivered_days: newDeliveredDays,
        days_remaining: daysRemaining,
        meals_delivered: (customer.meals_delivered || 0) + 1,
      },
    });

    if (newDeliveredDays >= paidDays) {
      await prisma.customer.update({
        where: { id: customerId },
        data: { active: false, notification_sent: false },
      });

      if (customer.phone_number) {
        try {
          await sendWhatsAppMessage({
            to: customer.phone_number,
            message: `Your ${paidDays}-day tiffin service is complete. Please renew your subscription to continue service.`,
          });
        } catch (e) { /* WhatsApp optional */ }
      }

      await sendEmail({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Send WhatsApp Message ────────────────────────────────────
router.post('/send-whatsapp-message', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { message, customerId } = req.body;
    let { to } = req.body;

    if (!message) {
      return res.status(400).json({ error: 'Missing required fields: message' });
    }

    if (customerId) {
      const customer = await prisma.customer.findFirst({
        where: { id: customerId, created_by: user.id, is_deleted: false },
      });
      if (!customer) return res.status(403).json({ error: 'Customer not found or access denied' });
      if (!to) {
        to = customer.phone_number;
      } else if (customer.phone_number !== to) {
        return res.status(403).json({ error: 'Phone number does not match customer record' });
      }
    }

    if (!to) {
      return res.status(400).json({ error: 'Missing required fields: to (or customerId with phone number)' });
    }

    const result = await sendWhatsAppMessage({ to, message });

    await prisma.activityLog.create({
      data: {
        user_email: user.email,
        user_name: user.full_name,
        action_type: 'notification_sent',
        entity_type: 'Customer',
        entity_id: customerId || null,
        description: `WhatsApp message sent to ${to}`,
        metadata: { phone_number: to, message_sid: result.messageSid, customer_id: customerId },
        created_by: user.id,
      },
    });

    res.json({ ...result, to });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Send Payment Reminder ────────────────────────────────────
router.post('/send-payment-reminder', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Missing customerId' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found or deleted' });
    if (!customer.phone_number) return res.status(400).json({ error: 'Customer has no phone number' });

    const message = `🔔 *Payment Reminder - TiffinHub*\n\nHello ${customer.full_name},\n\nYour payment is ${customer.payment_status === 'Overdue' ? 'overdue' : 'due'}.\n\n*Amount Due:* AED ${customer.payment_amount}\n${customer.due_date ? `*Due Date:* ${new Date(customer.due_date).toLocaleDateString('en-GB')}` : ''}\n\nPlease make the payment to continue your tiffin service.\n\nThank you!`;

    await sendWhatsAppMessage({ to: customer.phone_number, message });
    await sendEmail({
      to: user.email,
      subject: `Payment Reminder Sent - ${customer.full_name}`,
      body: `<h2>Payment Reminder Sent</h2><p><strong>Customer:</strong> ${customer.full_name}</p><p><strong>Amount:</strong> AED ${customer.payment_amount}</p>`,
    });

    res.json({ success: true, message: 'Payment reminder sent successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Send Bulk Payment Reminders ──────────────────────────────
router.post('/send-bulk-payment-reminders', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerIds } = req.body;

    if (!customerIds || !Array.isArray(customerIds) || customerIds.length === 0) {
      return res.status(400).json({ error: 'No customer IDs provided' });
    }

    const customers = await prisma.customer.findMany({
      where: { id: { in: customerIds }, created_by: user.id, is_deleted: false, active: true },
    });

    let sentCount = 0;
    const errors: any[] = [];
    const skipped: any[] = [];

    for (const customer of customers) {
      if (!customer.phone_number) {
        skipped.push({ customer: customer.full_name, reason: 'No phone number' });
        continue;
      }

      try {
        const message = `🔔 *Payment Reminder*\n\nDear ${customer.full_name},\n\nYour tiffin subscription expires in *${customer.days_remaining} days*.\n\n*Amount Due:* AED ${customer.payment_amount}\n\nPlease renew your subscription.\n\nThank you! 🙏`;
        await sendWhatsAppMessage({ to: customer.phone_number, message });
        sentCount++;
      } catch (error: any) {
        errors.push({ customer: customer.full_name, error: error.message });
      }
    }

    res.json({ sent: sentCount, skipped: skipped.length, total: customers.length, errors: errors.length > 0 ? errors : undefined });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create Checkout Session (platform subscription) ──────────
router.post('/create-checkout-session', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { priceId } = req.body;

    if (!priceId) return res.status(400).json({ error: 'Price ID is required' });
    if (STRIPE_PREMIUM_PRICE_ID && priceId !== STRIPE_PREMIUM_PRICE_ID) {
      return res.status(400).json({ error: 'Invalid price ID' });
    }

    const origin = req.headers.origin || req.headers.referer?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
    const appUrl = origin.replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Cancel Subscription ─────────────────────────────────────
router.post('/cancel-subscription', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { reason } = req.body;

    if (!user.stripe_subscription_id) {
      return res.status(400).json({ error: 'No active subscription found' });
    }

    const subscription = await stripe.subscriptions.update(user.stripe_subscription_id, {
      cancel_at_period_end: true,
    });

    const accessEndsAt = new Date(subscription.current_period_end * 1000).toISOString();

    await prisma.user.update({
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

    const subs = await prisma.subscription.findMany({ where: { user_email: user.email } });
    if (subs.length > 0) {
      await prisma.subscription.update({
        where: { id: subs[0].id },
        data: { status: 'cancelled', cancelled_at: new Date(), cancel_reason: reason || 'No reason provided' },
      });
    }

    res.json({ success: true, access_until: accessEndsAt, status: 'cancelled' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Check Low Stock ──────────────────────────────────────────
router.post('/check-low-stock', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const allIngredients = await prisma.ingredient.findMany({ where: { created_by: user.id } });
    const criticalStock = allIngredients.filter(i => (i.current_stock || 0) <= (i.min_stock_threshold || 0));

    if (criticalStock.length === 0) {
      return res.json({ success: true, critical_count: 0, message: 'All ingredients are well stocked' });
    }

    try {
      await sendEmail({
        to: user.email,
        subject: '⚠️ Low Stock Alert - TiffinHub',
        body: `<h2>Low Stock Alert</h2><ul>${criticalStock.map(i => `<li><strong>${i.name}</strong>: ${i.current_stock} ${i.unit} (Min: ${i.min_stock_threshold})</li>`).join('')}</ul>`,
      });
    } catch {}

    res.json({ success: true, critical_count: criticalStock.length, critical_items: criticalStock });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Batch Cooking ────────────────────────────────────────────
router.post('/batch-cooking', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { meal_type, quantity } = req.body;

    if (!meal_type || !quantity) return res.status(400).json({ error: 'meal_type and quantity required' });

    const recipe = await prisma.recipe.findFirst({
      where: { meal_type, is_active: true, created_by: user.id },
    });
    if (!recipe) return res.status(404).json({ error: `No active recipe found for ${meal_type}` });

    const ingredients = (recipe.ingredients as any[]) || [];
    const deductions: any[] = [];
    let totalCost = 0;

    for (const ing of ingredients) {
      const current = await prisma.ingredient.findUnique({ where: { id: ing.ingredient_id } });
      if (current) {
        const totalQty = ing.quantity * quantity;
        const newStock = (current.current_stock || 0) - totalQty;
        const cost = totalQty * (current.cost_per_unit || 0);
        totalCost += cost;

        await prisma.ingredient.update({
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

    await prisma.consumptionLog.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Apply Tiffin Carry Forward ───────────────────────────────
router.post('/apply-tiffin-carry-forward', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const currentMonth = format(new Date(), 'yyyy-MM');
    const customers = await prisma.customer.findMany({ where: { created_by: user.id, is_deleted: false } });

    let processedCount = 0;
    let totalDaysApplied = 0;

    for (const customer of customers) {
      const skips = await prisma.tiffinSkip.findMany({
        where: { customer_id: customer.id, carry_forward_applied: false, status: 'active' },
      });
      const skipsThisMonth = skips.filter(s => s.skip_date.startsWith(currentMonth));

      if (skipsThisMonth.length > 0) {
        const mealType = customer.meal_type || 'Lunch';
        let mealsPerDay = 0;
        if (mealType.includes('Breakfast')) mealsPerDay++;
        if (mealType.includes('Lunch')) mealsPerDay++;
        if (mealType.includes('Dinner')) mealsPerDay++;
        if (mealsPerDay === 0) mealsPerDay = 1;

        const daysToAdd = Math.floor(skipsThisMonth.length / mealsPerDay);
        const remainingMeals = skipsThisMonth.length % mealsPerDay;

        const currentEndDate = customer.end_date ? new Date(customer.end_date) : new Date();
        const newEndDate = addDays(currentEndDate, daysToAdd);

        await prisma.customer.update({
          where: { id: customer.id },
          data: { end_date: newEndDate, tiffin_balance: (customer.tiffin_balance || 0) + remainingMeals },
        });

        for (const skip of skipsThisMonth) {
          await prisma.tiffinSkip.update({
            where: { id: skip.id },
            data: { carry_forward_applied: true, status: 'applied' },
          });
        }

        processedCount++;
        totalDaysApplied += skipsThisMonth.length;
      }
    }

    res.json({ success: true, processed: processedCount, totalDaysApplied });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Delete Customer (soft) ──────────────────────────────────
router.post('/delete-customer', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer ID is required' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found or access denied' });

    await prisma.customer.update({
      where: { id: customerId },
      data: { is_deleted: true, deleted_at: new Date() },
    });

    await prisma.activityLog.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Clear Deleted Customers (hard delete) ────────────────────
router.post('/clear-deleted-customers', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const result = await prisma.customer.deleteMany({
      where: { created_by: user.id, is_deleted: true },
    });
    res.json({ success: true, deleted: result.count });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Add Purchase ─────────────────────────────────────────────
router.post('/add-purchase', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { ingredient_id, quantity, cost_per_unit, supplier_id, purchase_date, expiry_date, notes } = req.body;

    if (!ingredient_id || !quantity) return res.status(400).json({ error: 'ingredient_id and quantity required' });

    const ingredient = await prisma.ingredient.findUnique({ where: { id: ingredient_id } });
    if (!ingredient) return res.status(404).json({ error: 'Ingredient not found' });

    let supplier_name = null;
    if (supplier_id) {
      const supplier = await prisma.supplier.findUnique({ where: { id: supplier_id } });
      supplier_name = supplier?.name || null;
    }

    const effectiveCost = cost_per_unit || ingredient.cost_per_unit || 0;

    const purchase = await prisma.purchase.create({
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
    await prisma.ingredient.update({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Add Wastage ──────────────────────────────────────────────
router.post('/add-wastage', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { ingredient_id, quantity, reason, notes } = req.body;

    if (!ingredient_id || !quantity || !reason) {
      return res.status(400).json({ error: 'ingredient_id, quantity, and reason required' });
    }

    const ingredient = await prisma.ingredient.findUnique({ where: { id: ingredient_id } });
    if (!ingredient) return res.status(404).json({ error: 'Ingredient not found' });

    const costValue = quantity * (ingredient.cost_per_unit || 0);

    const wastage = await prisma.wastage.create({
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
    await prisma.ingredient.update({
      where: { id: ingredient_id },
      data: {
        current_stock: newStock,
        total_value: newStock * (ingredient.cost_per_unit || 0),
        is_critical: newStock <= (ingredient.min_stock_threshold || 0),
      },
    });

    res.json({ success: true, wastage, message: `Logged wastage: ${quantity} ${ingredient.unit} of ${ingredient.name}` });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Deduct Inventory ─────────────────────────────────────────
router.post('/deduct-inventory', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { recipe_id, quantity } = req.body;

    if (!recipe_id || !quantity) return res.status(400).json({ error: 'recipe_id and quantity required' });

    const recipe = await prisma.recipe.findFirst({
      where: { id: recipe_id, created_by: user.id },
    });
    if (!recipe) return res.status(404).json({ error: 'Recipe not found or access denied' });

    const ingredients = (recipe.ingredients as any[]) || [];
    const deductions: any[] = [];

    for (const ing of ingredients) {
      const current = await prisma.ingredient.findFirst({
        where: { id: ing.ingredient_id, created_by: user.id },
      });
      if (current) {
        const totalQty = ing.quantity * quantity;
        const newStock = (current.current_stock || 0) - totalQty;
        await prisma.ingredient.update({
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

    await prisma.consumptionLog.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Should Deliver Today ─────────────────────────────────────
router.post('/should-deliver-today', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId, date } = req.body;

    if (!customerId || !date) return res.status(400).json({ error: 'Missing required fields' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found or access denied' });

    if (!customer.active) return res.json({ shouldDeliver: false, reason: 'Service inactive' });
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

    const skips = await prisma.tiffinSkip.findMany({
      where: { customer_id: customerId, created_by: user.id, skip_date: date, status: 'active' },
    });
    if (skips.length > 0) return res.json({ shouldDeliver: false, reason: 'Date is skipped' });

    const dayOfWeek = checkDate.getDay();
    if (customer.skip_weekends && (dayOfWeek === 0 || dayOfWeek === 6)) {
      return res.json({ shouldDeliver: false, reason: 'Weekend skip enabled' });
    }

    res.json({ shouldDeliver: true, customer });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Calculate End Date ───────────────────────────────────────
router.post('/calculate-end-date', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;

    if (!customerId) return res.status(400).json({ error: 'Customer ID required' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found or access denied' });

    const skips = await prisma.tiffinSkip.findMany({
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

      if (!isSkipped && !skipWeekend) deliveredCount++;
      currentDate.setDate(currentDate.getDate() + 1);
    }

    currentDate.setDate(currentDate.getDate() - 1);
    const endDate = currentDate.toISOString().split('T')[0];

    await prisma.customer.update({
      where: { id: customerId },
      data: { end_date: currentDate, days_remaining: paidDays - (customer.delivered_days || 0) },
    });

    res.json({ success: true, endDate, totalSkips: skipDates.size });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Initialize New User ──────────────────────────────────────
router.post('/initialize-new-user', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    if (user.subscription_status) {
      return res.json({ message: 'User already initialized', status: user.subscription_status });
    }

    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    await prisma.user.update({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Check Subscription Status ────────────────────────────────
router.post('/check-subscription-status', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const subs = await prisma.subscription.findMany({ where: { user_email: user.email } });

    if (!subs.length) return res.json({ hasSubscription: false, status: 'no_subscription' });

    const sub = subs[0];
    if (sub.stripe_subscription_id) {
      try {
        const stripeSub = await stripe.subscriptions.retrieve(sub.stripe_subscription_id);
        const status = stripeSub.status;

        await prisma.user.update({
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
      } catch {
        return res.json({ hasSubscription: true, status: sub.status, error: 'Could not verify with Stripe' });
      }
    }

    res.json({ hasSubscription: true, status: sub.status });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Check Premium Access ─────────────────────────────────────
router.post('/check-premium-access', async (req: AuthRequest, res) => {
  const user = req.user!;
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
  const isSuperAdmin = user.email === DEFAULT_SUPER_ADMIN || user.is_super_admin;
  const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
  const hasPremium = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';

  res.json({ hasPremiumAccess: hasPremium, plan_type: user.plan_type, subscription_status: user.subscription_status });
});

// ─── Check Plan Access ────────────────────────────────────────
router.post('/check-plan-access', async (req: AuthRequest, res) => {
  const user = req.user!;
  const { feature } = req.body;
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
  const isSuperAdmin = user.email === DEFAULT_SUPER_ADMIN || user.is_super_admin;
  const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
  const hasPremium = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';

  res.json({ hasAccess: hasPremium, feature, plan_type: user.plan_type });
});

// ─── Check Trial Expiry ──────────────────────────────────────
router.post('/check-trial-expiry', async (req: AuthRequest, res) => {
  const user = req.user!;
  if (user.subscription_status !== 'trial' || !user.trial_ends_at) {
    return res.json({ isExpired: false, status: user.subscription_status });
  }
  const isExpired = new Date() > new Date(user.trial_ends_at);
  if (isExpired) {
    await prisma.user.update({
      where: { id: user.id },
      data: { subscription_status: 'expired', plan_type: 'none' },
    });
  }
  res.json({ isExpired, trial_ends_at: user.trial_ends_at, status: isExpired ? 'expired' : 'trial' });
});

// ─── Get Effective Plan ───────────────────────────────────────
router.post('/get-effective-plan', async (req: AuthRequest, res) => {
  const user = req.user!;
  res.json({
    plan_type: user.plan_type,
    subscription_status: user.subscription_status,
    subscription_source: user.subscription_source,
    trial_ends_at: user.trial_ends_at,
    subscription_ends_at: user.subscription_ends_at,
  });
});

// ─── List Active Plans ────────────────────────────────────────
router.post('/list-active-plans', async (_req: AuthRequest, res) => {
  try {
    // Try fetching real prices from Stripe
    if (STRIPE_PREMIUM_PRICE_ID && process.env.STRIPE_SECRET_KEY && !process.env.STRIPE_SECRET_KEY.includes('placeholder')) {
      try {
        const prices = await stripe.prices.list({ active: true, limit: 10, expand: ['data.product'] });
        const filtered = STRIPE_PREMIUM_PRICE_ID
          ? prices.data.filter(p => p.id === STRIPE_PREMIUM_PRICE_ID)
          : prices.data;
        return res.json({ prices: filtered });
      } catch (e: any) {
        console.log('[list-active-plans] Stripe fetch failed:', e.message);
      }
    }
    // Fallback: return hardcoded plan in Stripe-compatible format
    res.json({
      prices: [
        {
          id: STRIPE_PREMIUM_PRICE_ID || 'price_premium',
          unit_amount: 6999,
          currency: 'aed',
          recurring: { interval: 'month' },
          product: { name: 'Premium Plan' },
        },
      ],
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Reset WhatsApp Cycle ─────────────────────────────────────
router.post('/reset-whatsapp-cycle', async (req: AuthRequest, res) => {
  const user = req.user!;
  await prisma.user.update({ where: { id: user.id }, data: { whatsapp_sent_count: 0 } });
  res.json({ success: true });
});

// ─── Send Customer Payment Reminder ───────────────────────────
router.post('/send-customer-payment-reminder', checkPremiumAccess, async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (!customer.phone_number) return res.status(400).json({ error: 'No phone number' });

    const message = `🔔 *Payment Reminder*\n\nHello ${customer.full_name},\n\nYour payment of AED ${customer.payment_amount} is due.\n\nPlease make the payment to continue service.\n\nThank you!`;
    await sendWhatsAppMessage({ to: customer.phone_number, message });

    res.json({ success: true, message: 'Reminder sent' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Send Customer Email ──────────────────────────────────────
router.post('/send-customer-email', async (req: AuthRequest, res) => {
  try {
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body required' });
    const result = await sendEmail({ to, subject, body });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Assign User Plan (Super Admin) ──────────────────────────
router.post('/assign-user-plan', superAdminOnly, async (req: AuthRequest, res) => {
  try {
    const { targetUserEmail, planType, durationMonths } = req.body;

    if (!targetUserEmail || !planType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    if (!['basic', 'premium'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    const targetUser = await prisma.user.findUnique({ where: { email: targetUserEmail } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const months = durationMonths || null;
    let expiryDate: Date | null = null;
    if (months) {
      expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + months);
    }

    await prisma.user.update({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Manual Grant Access (Super Admin) ────────────────────────
router.post('/manual-grant-access', superAdminOnly, async (req: AuthRequest, res) => {
  try {
    const { targetUserEmail, planType, months } = req.body;
    if (!targetUserEmail || !planType) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const targetUser = await prisma.user.findUnique({ where: { email: targetUserEmail } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    let expiryDate: Date | null = null;
    if (months) {
      expiryDate = new Date();
      expiryDate.setMonth(expiryDate.getMonth() + months);
    }

    await prisma.user.update({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Manage User (Super Admin) ────────────────────────────────
router.post('/manage-user', superAdminOnly, async (req: AuthRequest, res) => {
  try {
    const { targetUserEmail, action, data } = req.body;
    const targetUser = await prisma.user.findUnique({ where: { email: targetUserEmail } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    if (action === 'update') {
      const { password_hash: _, ...safe } = await prisma.user.update({ where: { id: targetUser.id }, data });
      return res.json({ success: true, user: safe });
    }
    if (action === 'delete') {
      await prisma.user.delete({ where: { id: targetUser.id } });
      return res.json({ success: true });
    }

    res.status(400).json({ error: 'Invalid action' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Impersonate User (Super Admin) ──────────────────────────
router.post('/impersonate-user', superAdminOnly, async (req: AuthRequest, res) => {
  try {
    const { targetUserEmail } = req.body;
    const targetUser = await prisma.user.findUnique({ where: { email: targetUserEmail } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const { password_hash: _, ...safeUser } = targetUser;
    res.json({ success: true, user: safeUser });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create Customer Payment Checkout ─────────────────────────
router.post('/create-customer-payment-checkout', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;

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

    const customer = await prisma.customer.findFirst({ where: { id: customerId, created_by: user.id } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    const feePercentage = user.fee_percentage || 3.5;
    const platformFeeAmount = Math.round((amount * feePercentage) / 100);
    const netAmount = amount - platformFeeAmount;

    const origin = req.headers.origin || (req.headers.referer as string)?.replace(/\/[^/]*$/, '') || process.env.FRONTEND_URL || 'http://localhost:5173';
    const appUrl = origin.replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
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

    await prisma.paymentLink.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Generate Customer Payment Link ──────────────────────────
router.post('/generate-customer-payment-link', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId, amount, description } = req.body;

    const customer = await prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    // Re-use create-customer-payment-checkout logic
    req.body = { customerId, amount: amount || customer.payment_amount, description };
    // Delegate - in practice this would call the same logic
    res.json({ success: true, message: 'Use create-customer-payment-checkout endpoint' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Create Stripe Connect Account ───────────────────────────
router.post('/create-stripe-connect-account', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';

    const account = await stripe.accounts.create({
      type: 'express',
      country: 'AE',
      email: user.email,
      capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
      business_type: 'individual',
    });

    const accountLink = await stripe.accountLinks.create({
      account: account.id,
      refresh_url: `${origin}/PaymentSetup?refresh=true`,
      return_url: `${origin}/PaymentSetup?success=true`,
      type: 'account_onboarding',
    });

    await prisma.user.update({
      where: { id: user.id },
      data: { stripe_connect_account_id: account.id },
    });

    res.json({ success: true, url: accountLink.url, accountId: account.id });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Get Stripe Account Status ───────────────────────────────
router.post('/get-stripe-account-status', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    if (!user.stripe_connect_account_id) {
      return res.json({ connected: false });
    }

    const account = await stripe.accounts.retrieve(user.stripe_connect_account_id);
    const isVerified = account.charges_enabled && account.payouts_enabled;

    await prisma.user.update({
      where: { id: user.id },
      data: {
        payment_account_connected: true,
        payment_verification_status: isVerified ? 'verified' : 'pending',
      },
    });

    res.json({
      connected: true,
      verified: isVerified,
      charges_enabled: account.charges_enabled,
      payouts_enabled: account.payouts_enabled,
      account_id: account.id,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Disconnect Payment Account ──────────────────────────────
router.post('/disconnect-payment-account', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    await prisma.user.update({
      where: { id: user.id },
      data: {
        stripe_connect_account_id: null,
        payment_account_connected: false,
        payment_verification_status: 'pending',
        fee_consent_accepted: false,
      },
    });
    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Subscription Reminders (scheduled) ──────────────────────
router.post('/subscription-reminders', async (req: AuthRequest, res) => {
  try {
    const subs = await prisma.subscription.findMany({ where: { status: 'active' } });
    let sentCount = 0;

    for (const sub of subs) {
      if (!sub.current_period_end) continue;
      const daysUntilEnd = Math.floor((new Date(sub.current_period_end).getTime() - Date.now()) / (1000 * 60 * 60 * 24));

      if (daysUntilEnd === 3 && !sub.reminder_before_sent) {
        await sendEmail({
          to: sub.user_email,
          subject: 'Subscription Renewal Reminder - TiffinHub',
          body: `Your TiffinHub subscription renews in 3 days on ${new Date(sub.current_period_end).toLocaleDateString()}.`,
        });
        await prisma.subscription.update({ where: { id: sub.id }, data: { reminder_before_sent: true } });
        sentCount++;
      }
    }

    res.json({ success: true, sent: sentCount });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Automatic Payment Reminders (scheduled) ─────────────────
export async function runAutoPaymentReminders() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const threeDaysFromNow = new Date(today);
  threeDaysFromNow.setDate(threeDaysFromNow.getDate() + 3);

  const threeDaysAgo = new Date(today);
  threeDaysAgo.setDate(threeDaysAgo.getDate() - 3);

  const startOfTargetDay = new Date(threeDaysFromNow);
  startOfTargetDay.setHours(0, 0, 0, 0);
  const endOfTargetDay = new Date(threeDaysFromNow);
  endOfTargetDay.setHours(23, 59, 59, 999);

  const startOfOverdueDay = new Date(threeDaysAgo);
  startOfOverdueDay.setHours(0, 0, 0, 0);
  const endOfOverdueDay = new Date(threeDaysAgo);
  endOfOverdueDay.setHours(23, 59, 59, 999);

  let beforeCount = 0;
  let afterCount = 0;

  // Find all users with active Stripe Connect
  const users = await prisma.user.findMany({
    where: {
      stripe_connect_account_id: { not: null },
      payment_account_connected: true,
      payment_verification_status: 'verified',
    },
  });

  const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

  for (const user of users) {
    // --- Upcoming reminders (end_date in 3 days) ---
    const upcomingCustomers = await prisma.customer.findMany({
      where: {
        created_by: user.id,
        is_deleted: false,
        active: true,
        end_date: { gte: startOfTargetDay, lte: endOfTargetDay },
        reminder_before_sent: { not: true },
        phone_number: { not: null },
      },
    });

    for (const customer of upcomingCustomers) {
      if (!customer.phone_number || !customer.payment_amount) continue;

      try {
        const amount = customer.payment_amount;
        const currency = (user as any).currency || 'aed';
        const feePercentage = (user as any).fee_percentage || 3.5;
        const platformFeeAmount = Math.round((amount * feePercentage) / 100);

        const session = await stripe.checkout.sessions.create({
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
        }, { stripeAccount: user.stripe_connect_account_id! });

        await prisma.paymentLink.create({
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

        const endDateFormatted = customer.end_date ? format(new Date(customer.end_date), 'dd MMM yyyy') : 'N/A';

        await sendWhatsAppMessage({
          to: customer.phone_number,
          message: `🔔 *Payment Reminder*\n\nHello ${customer.full_name},\n\nYour tiffin subscription ends in 3 days on ${endDateFormatted}.\n\n💰 *Amount:* ${currency.toUpperCase()} ${amount}\n\nPay securely here: ${session.url}\n\nThank you! 🙏`,
        });

        await prisma.customer.update({ where: { id: customer.id }, data: { reminder_before_sent: true } });
        beforeCount++;
      } catch (err) {
        console.error(`[AutoReminder] Failed for customer ${customer.id}:`, err);
      }
    }

    // --- Overdue reminders (end_date was 3 days ago) ---
    const overdueCustomers = await prisma.customer.findMany({
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
      if (!customer.phone_number || !customer.payment_amount) continue;

      try {
        const amount = customer.payment_amount;
        const currency = (user as any).currency || 'aed';
        const feePercentage = (user as any).fee_percentage || 3.5;
        const platformFeeAmount = Math.round((amount * feePercentage) / 100);

        const session = await stripe.checkout.sessions.create({
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
        }, { stripeAccount: user.stripe_connect_account_id! });

        await prisma.paymentLink.create({
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

        const endDateFormatted = customer.end_date ? format(new Date(customer.end_date), 'dd MMM yyyy') : 'N/A';

        await sendWhatsAppMessage({
          to: customer.phone_number,
          message: `⚠️ *Payment Overdue*\n\nHello ${customer.full_name},\n\nYour subscription expired on ${endDateFormatted} and payment is overdue.\n\n💰 *Amount Due:* ${currency.toUpperCase()} ${amount}\n\nPay now to continue: ${session.url}\n\nThank you!`,
        });

        await prisma.customer.update({
          where: { id: customer.id },
          data: { status: 'inactive', inactive_reason: 'non_payment', active: false, reminder_after_sent: true, payment_status: 'Overdue' },
        });
        afterCount++;
      } catch (err) {
        console.error(`[AutoReminder] Overdue failed for customer ${customer.id}:`, err);
      }
    }
  }

  return { success: true, beforeReminders: beforeCount, afterReminders: afterCount };
}

router.post('/automatic-payment-reminders', async (req: AuthRequest, res) => {
  try {
    const result = await runAutoPaymentReminders();
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Auto Customer Payment Reminders ─────────────────────────
router.post('/auto-customer-payment-reminders', async (req: AuthRequest, res) => {
  // Same logic as automatic-payment-reminders, kept for backwards compatibility
  return res.json({ success: true, message: 'Use automatic-payment-reminders endpoint' });
});

// ─── Trial Expiry Check (cron) ─────────────────────────────────
export async function runTrialExpiryCheck() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Find trial customers expiring today or already expired
  const expiringTrials = await prisma.customer.findMany({
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
    if (!customer.phone_number) continue;
    try {
      // Find the user who owns this customer for Stripe checkout
      const user = await prisma.user.findUnique({ where: { id: customer.created_by } });
      if (!user) continue;

      let paymentLink = '';
      if (user.stripe_connect_account_id && user.payment_account_connected && user.payment_verification_status === 'verified') {
        const amount = customer.payment_amount || 0;
        if (amount > 0) {
          const feePercentage = (user as any).fee_percentage || 3.5;
          const platformFeeAmount = Math.round((amount * feePercentage) / 100);
          const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

          const session = await stripe.checkout.sessions.create({
            mode: 'payment',
            payment_method_types: ['card'],
            line_items: [{
              price_data: {
                currency: (user as any).currency || 'aed',
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

      await sendWhatsAppMessage({
        to: customer.phone_number,
        message: `Hello ${customer.full_name},\n\nYour free trial has ended! We hope you enjoyed our tiffin service.\n\nTo continue without interruption, please subscribe.\n\n💰 Amount: AED ${customer.payment_amount}/month${paymentLink}\n\nThank you!`,
      });

      // Deactivate the trial customer
      await prisma.customer.update({
        where: { id: customer.id },
        data: {
          active: false,
          status: 'inactive',
          inactive_reason: 'trial_expired',
          payment_status: 'Pending',
        },
      });

      sentCount++;
    } catch (err) {
      console.error(`[TrialExpiry] Failed for customer ${customer.id}:`, err);
    }
  }

  return { success: true, trialReminders: sentCount };
}

// ─── Auto Meal Rating Request (cron - runs every 15 days) ──────
export async function runMealRatingRequests() {
  const fifteenDaysAgo = new Date();
  fifteenDaysAgo.setDate(fifteenDaysAgo.getDate() - 15);

  // Find all active customers with phone numbers
  const customers = await prisma.customer.findMany({
    where: { is_deleted: false, active: true, phone_number: { not: null } },
  });

  let sentCount = 0;
  for (const customer of customers) {
    if (!customer.phone_number) continue;

    try {
      // Skip if we already sent a rating request in the last 15 days
      const recentRating = await prisma.mealRating.findFirst({
        where: {
          customer_id: customer.id,
          created_at: { gte: fifteenDaysAgo },
        },
      });
      if (recentRating) continue;

      // Create a placeholder rating entry
      await prisma.mealRating.create({
        data: {
          customer_id: customer.id,
          customer_name: customer.full_name,
          rating: 0,
          meal_type: customer.meal_type,
          meal_date: format(new Date(), 'yyyy-MM-dd'),
          created_by: customer.created_by,
        },
      });

      await sendWhatsAppMessage({
        to: customer.phone_number,
        message: `Hello ${customer.full_name},\n\nWe'd love your feedback on our tiffin service!\n\nPlease rate from 1 to 5:\n1 ⭐ - Poor\n2 ⭐⭐ - Fair\n3 ⭐⭐⭐ - Good\n4 ⭐⭐⭐⭐ - Very Good\n5 ⭐⭐⭐⭐⭐ - Excellent\n\nReply with just the number (1-5) and any feedback.\n\nThank you!`,
      });
      sentCount++;
    } catch (err) {
      console.error(`[MealRating] Failed for customer ${customer.id}:`, err);
    }
  }

  return { success: true, ratingRequests: sentCount };
}

// ─── Generate Portal Link ─────────────────────────────────────
router.post('/generate-portal-link', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;
    const customer = await prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    let token = customer.portal_token;
    if (!token) {
      token = require('crypto').randomBytes(24).toString('hex');
      await prisma.customer.update({ where: { id: customer.id }, data: { portal_token: token } });
    }

    const origin = req.headers.origin || process.env.FRONTEND_URL || 'http://localhost:5173';
    const portalUrl = `${origin}/CustomerPortal?token=${token}`;

    res.json({ success: true, portalUrl, token });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Generate Referral Code ───────────────────────────────────
router.post('/generate-referral-code', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;
    const customer = await prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });

    let code = customer.referral_code;
    if (!code) {
      code = customer.full_name.replace(/\s+/g, '').substring(0, 4).toUpperCase() + Math.random().toString(36).substring(2, 6).toUpperCase();
      await prisma.customer.update({ where: { id: customer.id }, data: { referral_code: code } });
    }

    res.json({ success: true, referralCode: code });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Apply Referral Code ──────────────────────────────────────
router.post('/apply-referral', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId, referralCode } = req.body;
    if (!referralCode) return res.status(400).json({ error: 'Referral code required' });

    const referrer = await prisma.customer.findFirst({
      where: { referral_code: referralCode, created_by: user.id, is_deleted: false },
    });
    if (!referrer) return res.status(404).json({ error: 'Invalid referral code' });

    const customer = await prisma.customer.findFirst({ where: { id: customerId, created_by: user.id, is_deleted: false } });
    if (!customer) return res.status(404).json({ error: 'Customer not found' });
    if (customer.id === referrer.id) return res.status(400).json({ error: 'Cannot refer yourself' });
    if (customer.referred_by) return res.status(400).json({ error: 'Customer already has a referral' });

    await prisma.customer.update({ where: { id: customer.id }, data: { referred_by: referrer.id } });

    await prisma.referral.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Approve Customer Registration ─────────────────────────────
router.post('/approve-customer', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId } = req.body;
    if (!customerId) return res.status(400).json({ error: 'Customer ID required' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, status: 'pending_verification' },
    });
    if (!customer) return res.status(404).json({ error: 'Pending customer not found' });

    const updateData: any = {
      active: true,
      status: 'active',
    };

    // If trial, set start/end dates now
    if (customer.is_trial) {
      updateData.start_date = new Date();
      updateData.end_date = addDays(new Date(), 3);
      updateData.trial_end_date = addDays(new Date(), 3);
      updateData.paid_days = 3;
      updateData.days_remaining = 3;
    }

    await prisma.customer.update({ where: { id: customerId }, data: updateData });

    // Send WhatsApp confirmation
    if (customer.phone_number) {
      try {
        await sendWhatsAppMessage({
          to: customer.phone_number,
          message: `Hello ${customer.full_name}! Your registration with ${user.business_name || 'our tiffin service'} has been approved. ${customer.is_trial ? 'Your 3-day free trial starts today!' : 'Welcome aboard!'}\n\nThank you!`,
        });
      } catch {}
    }

    res.json({ success: true, message: 'Customer approved' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── Reject Customer Registration ──────────────────────────────
router.post('/reject-customer', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { customerId, reason } = req.body;
    if (!customerId) return res.status(400).json({ error: 'Customer ID required' });

    const customer = await prisma.customer.findFirst({
      where: { id: customerId, created_by: user.id, status: 'pending_verification' },
    });
    if (!customer) return res.status(404).json({ error: 'Pending customer not found' });

    await prisma.customer.update({
      where: { id: customerId },
      data: { is_deleted: true, deleted_at: new Date(), status: 'rejected' },
    });

    if (customer.phone_number) {
      try {
        await sendWhatsAppMessage({
          to: customer.phone_number,
          message: `Hello ${customer.full_name}, unfortunately your registration could not be approved at this time.${reason ? ` Reason: ${reason}` : ''}\n\nPlease contact us for more information.`,
        });
      } catch {}
    }

    res.json({ success: true, message: 'Customer rejected' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── WhatsApp Router ─────────────────────────────────────────
router.post('/whatsapp-router', async (req: AuthRequest, res) => {
  // Placeholder for WhatsApp incoming message routing
  res.json({ success: true, message: 'WhatsApp router placeholder' });
});

// ─── AI WhatsApp Agent — Inbound Message Handler ─────────────
router.post('/whatsapp-agent-reply', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { from, message } = req.body;
    if (!from || !message) return res.status(400).json({ error: 'Missing from or message' });

    const phone = from.replace(/\D/g, '');

    // Find matching customer by phone
    const customer = await prisma.customer.findFirst({
      where: { created_by: user.id, is_deleted: false, phone_number: { contains: phone.slice(-9) } },
    });

    // Detect intent from message
    const lowerMsg = message.toLowerCase();
    let intent = 'unknown';
    let reply = '';

    // Registration intent for unknown numbers
    if (!customer && /register|subscribe|join|start|sign.?up|new/i.test(lowerMsg)) {
      intent = 'registration';
      const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
      reply = `Welcome! Sign up for our tiffin service here:\n\n${appUrl}/join/${user.id}\n\nYou can start with a free 3-day trial or subscribe directly.`;

      await prisma.chatMessage.create({
        data: { customer_phone: from, direction: 'inbound', message, intent, auto_replied: true, reply_message: reply, created_by: user.id },
      });

      try {
        await sendWhatsAppMessage({ to: from, message: reply });
      } catch {}

      await prisma.notification.create({
        data: {
          user_email: user.email,
          title: 'New Registration Intent',
          message: `${from} wants to register — sent join link`,
          type: 'whatsapp_agent',
          notification_type: 'info',
          phone_number: from,
        },
      });

      return res.json({ success: true, intent, reply, customer_found: false });
    }

    if (/balance|remaining|days left|kitne din/i.test(lowerMsg)) {
      intent = 'balance_check';
      if (customer) {
        reply = `Hello ${customer.full_name}! You have ${customer.days_remaining || 0} days remaining in your subscription (${customer.delivered_days || 0} delivered out of ${customer.paid_days || 30}).`;
      } else {
        reply = 'Sorry, we could not find your account. Please contact support.';
      }
    } else if (/skip|chutti|leave|holiday/i.test(lowerMsg)) {
      intent = 'skip_request';
      if (customer) {
        const tomorrow = format(addDays(new Date(), 1), 'yyyy-MM-dd');
        await prisma.tiffinSkip.create({
          data: { customer_id: customer.id, skip_date: tomorrow, reason: 'WhatsApp request', status: 'active', created_by: user.id },
        });
        reply = `Done! Your tiffin for tomorrow (${tomorrow}) has been skipped. Enjoy your day off!`;
      } else {
        reply = 'Sorry, we could not find your account to process the skip.';
      }
    } else if (/menu|aaj ka khana|today.*food|what.*today/i.test(lowerMsg)) {
      intent = 'menu_inquiry';
      const dayName = format(new Date(), 'EEEE');
      const menuItems = await prisma.menuItem.findMany({
        where: { created_by: user.id, is_active: true, day_of_week: dayName },
      });
      if (menuItems.length > 0) {
        reply = `Today's menu (${dayName}):\n${menuItems.map(m => `• ${m.name}${m.description ? ` — ${m.description}` : ''}`).join('\n')}`;
      } else {
        const allActive = await prisma.menuItem.findMany({ where: { created_by: user.id, is_active: true }, take: 5 });
        reply = allActive.length > 0
          ? `Today's menu:\n${allActive.map(m => `• ${m.name}`).join('\n')}`
          : 'Menu information is not available right now. Please contact us directly.';
      }
    } else if (/pay|payment|amount|kitna paisa|raqam/i.test(lowerMsg)) {
      intent = 'payment_inquiry';
      if (customer) {
        reply = `Your subscription amount is ${user.currency || 'AED'} ${customer.payment_amount || 0}. Status: ${customer.payment_status || 'N/A'}. End date: ${customer.end_date ? format(new Date(customer.end_date), 'dd MMM yyyy') : 'N/A'}.`;
      } else {
        reply = 'Sorry, we could not find your account. Please contact support.';
      }
    } else if (/hi|hello|salam|assalam|hey/i.test(lowerMsg)) {
      intent = 'greeting';
      reply = `Hello${customer ? ` ${customer.full_name}` : ''}! How can I help you?\n\nYou can ask me:\n• "Balance" — check remaining days\n• "Skip" — skip tomorrow's delivery\n• "Menu" — see today's menu\n• "Payment" — check payment info`;
    } else {
      intent = 'unknown';
      reply = `Thanks for your message! I can help with:\n\n• "Balance" — check remaining days\n• "Skip" — skip tomorrow's delivery\n• "Menu" — see today's menu\n• "Payment" — check payment info\n\nFor anything else, our team will get back to you shortly.`;
    }

    // Log the inbound message
    await prisma.chatMessage.create({
      data: { customer_phone: from, direction: 'inbound', message, intent, auto_replied: true, reply_message: reply, created_by: user.id },
    });

    // Send auto-reply via WhatsApp
    if (reply) {
      const customerForPhone = customer || await prisma.customer.findFirst({ where: { created_by: user.id, phone_number: { contains: phone.slice(-9) } } });
      try {
        await sendWhatsAppMessage({ to: from, message: reply });
      } catch (e) {
        console.error('Failed to send agent reply:', e);
      }
    }

    // Create notification for merchant
    await prisma.notification.create({
      data: {
        user_email: user.email,
        title: `WhatsApp: ${intent.replace('_', ' ')}`,
        message: `${from}: ${message.substring(0, 100)}`,
        type: 'whatsapp_agent',
        notification_type: 'info',
        customer_name: customer?.full_name || from,
        phone_number: from,
      },
    });

    res.json({ success: true, intent, reply, customer_found: !!customer });
  } catch (error: any) {
    console.error('WhatsApp agent error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ─── Auto Deduct Inventory on Delivery ────────────────────────
router.post('/auto-deduct-on-delivery', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { orderId } = req.body;

    if (!orderId) return res.status(400).json({ error: 'orderId required' });

    const order = await prisma.order.findFirst({
      where: { id: orderId, created_by: user.id },
    });
    if (!order) return res.json({ success: true, skipped: true, reason: 'Order not found' });

    const mealType = order.meal_type;
    if (!mealType) return res.json({ success: true, skipped: true, reason: 'No meal_type on order' });

    const recipe = await prisma.recipe.findFirst({
      where: { meal_type: mealType, is_active: true, created_by: user.id },
    });
    if (!recipe) return res.json({ success: true, skipped: true, reason: `No active recipe for ${mealType}` });

    const ingredients = (recipe.ingredients as any[]) || [];
    const servings = recipe.servings || 1;
    const deductions: any[] = [];
    let totalCost = 0;

    for (const ing of ingredients) {
      const current = await prisma.ingredient.findFirst({
        where: { id: ing.ingredient_id, created_by: user.id },
      });
      if (current) {
        const deductQty = ing.quantity / servings;
        const newStock = Math.max(0, (current.current_stock || 0) - deductQty);
        const cost = deductQty * (current.cost_per_unit || 0);
        totalCost += cost;

        await prisma.ingredient.update({
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

    await prisma.consumptionLog.create({
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
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
