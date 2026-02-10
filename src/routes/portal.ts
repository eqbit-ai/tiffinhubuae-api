import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { format, addDays, addMonths, differenceInDays, parseISO } from 'date-fns';
import { sendEmail } from '../services/email';
import { stripe } from '../services/stripe';
import { sendSMS } from '../services/sms';
import { sendMerchantWhatsApp } from '../services/whatsapp';
import { customerAuthMiddleware, CustomerAuthRequest, generateCustomerToken } from '../middleware/auth';

const router = Router();

// ─────────────────────────────────────────────────────────────────
// OTP AUTHENTICATION ENDPOINTS
// ─────────────────────────────────────────────────────────────────

// Generate a 6-digit OTP
function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Normalize phone number: strip spaces/dashes, ensure we can match with or without '+'
function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-()]/g, '').trim();
}

// POST /api/portal/auth/request-otp - Request OTP for login
router.post('/auth/request-otp', async (req: Request, res: Response) => {
  try {
    const { phone_number, merchant_id } = req.body;

    if (!phone_number || !merchant_id) {
      return res.status(400).json({ error: 'Phone number and merchant ID are required' });
    }

    // Verify merchant exists
    const merchant = await prisma.user.findUnique({ where: { id: merchant_id } });
    if (!merchant) {
      return res.json({ success: true, message: 'If a customer exists with this phone number, an OTP has been sent' });
    }

    // Normalize and try multiple phone formats to handle +/- prefix mismatches
    const cleaned = normalizePhone(phone_number);
    const withPlus = cleaned.startsWith('+') ? cleaned : '+' + cleaned;
    const withoutPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

    // Find customer by phone number for this merchant (try both formats)
    const customer = await prisma.customer.findFirst({
      where: {
        phone_number: { in: [cleaned, withPlus, withoutPlus] },
        created_by: merchant_id,
        is_deleted: false,
      },
    });

    if (!customer) {
      // Return success anyway to prevent phone enumeration
      return res.json({ success: true, message: 'If a customer exists with this phone number, an OTP has been sent' });
    }

    // Use the customer's stored phone number for consistency
    const customerPhone = customer.phone_number!;

    // Rate limiting: Max 5 OTPs per phone per hour
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const recentOTPs = await prisma.customerOTP.count({
      where: {
        customer_id: customer.id,
        merchant_id,
        created_at: { gte: oneHourAgo },
      },
    });

    if (recentOTPs >= 5) {
      return res.status(429).json({ error: 'Too many OTP requests. Please try again later.' });
    }

    // Generate OTP and save
    const otpCode = generateOTP();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    await prisma.customerOTP.create({
      data: {
        phone_number: customerPhone,
        otp_code: otpCode,
        merchant_id,
        customer_id: customer.id,
        expires_at: expiresAt,
      },
    });

    // Send OTP via WhatsApp (counts toward merchant's 400 limit)
    const smsResult = await sendMerchantWhatsApp(merchant_id, {
      to: customerPhone,
      message: `Your TiffinHub login code is: ${otpCode}\n\nThis code expires in 10 minutes.\nDo not share this code with anyone.`,
      templateName: 'OTP_LOGIN',
      contentVariables: { '1': otpCode },
    });

    if (!smsResult || !smsResult.success) {
      console.error('[Portal OTP] SMS not sent:', smsResult?.reason || 'unknown');
      return res.status(500).json({ error: 'Failed to send OTP. Please try again later.' });
    }

    res.json({ success: true, message: 'OTP sent successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/auth/verify-otp - Verify OTP and return JWT
router.post('/auth/verify-otp', async (req: Request, res: Response) => {
  try {
    const { phone_number, merchant_id, otp } = req.body;

    if (!phone_number || !merchant_id || !otp) {
      return res.status(400).json({ error: 'Phone number, merchant ID, and OTP are required' });
    }

    // Normalize phone to find customer first
    const cleaned = normalizePhone(phone_number);
    const withPlus = cleaned.startsWith('+') ? cleaned : '+' + cleaned;
    const withoutPlus = cleaned.startsWith('+') ? cleaned.slice(1) : cleaned;

    // Find the customer to get their ID
    const customer = await prisma.customer.findFirst({
      where: {
        phone_number: { in: [cleaned, withPlus, withoutPlus] },
        created_by: merchant_id,
        is_deleted: false,
      },
    });

    if (!customer) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
    }

    // Find the most recent OTP for this customer/merchant
    const otpRecord = await prisma.customerOTP.findFirst({
      where: {
        customer_id: customer.id,
        merchant_id,
        verified: false,
        expires_at: { gt: new Date() },
      },
      orderBy: { created_at: 'desc' },
    });

    if (!otpRecord) {
      return res.status(400).json({ error: 'OTP expired or not found. Please request a new one.' });
    }

    // Check max attempts
    if (otpRecord.attempts >= 5) {
      return res.status(400).json({ error: 'Too many failed attempts. Please request a new OTP.' });
    }

    // Verify OTP
    if (otpRecord.otp_code !== otp) {
      await prisma.customerOTP.update({
        where: { id: otpRecord.id },
        data: { attempts: otpRecord.attempts + 1 },
      });
      return res.status(400).json({ error: 'Invalid OTP' });
    }

    // Mark OTP as verified
    await prisma.customerOTP.update({
      where: { id: otpRecord.id },
      data: { verified: true },
    });

    // Update last login
    await prisma.customer.update({
      where: { id: customer.id },
      data: { last_login_at: new Date() },
    });

    // Generate JWT
    const token = generateCustomerToken(customer.id, merchant_id);

    // Get merchant info
    const merchant = await prisma.user.findUnique({ where: { id: merchant_id } });

    res.json({
      success: true,
      token,
      customer: {
        id: customer.id,
        full_name: customer.full_name,
        phone_number: customer.phone_number,
      },
      merchant: {
        business_name: merchant?.business_name || 'Tiffin Service',
        currency: merchant?.currency || 'AED',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// AUTHENTICATED CUSTOMER ENDPOINTS (JWT Required)
// ─────────────────────────────────────────────────────────────────

// GET /api/portal/me - Get customer profile and subscription info
router.get('/me', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;
    const merchant = await prisma.user.findUnique({ where: { id: customer.merchant_id } });

    res.json({
      customer: {
        id: customer.id,
        full_name: customer.full_name,
        phone_number: customer.phone_number,
        address: customer.address,
        area: customer.area,
        meal_type: customer.meal_type,
        payment_amount: customer.payment_amount,
        payment_status: customer.payment_status,
        start_date: customer.start_date,
        end_date: customer.end_date,
        days_remaining: customer.days_remaining,
        paid_days: customer.paid_days,
        delivered_days: customer.delivered_days,
        roti_quantity: customer.roti_quantity,
        rice_type: customer.rice_type,
        dietary_preference: customer.dietary_preference,
        special_notes: customer.special_notes,
        skip_weekends: customer.skip_weekends,
        is_paused: customer.is_paused,
        pause_start_date: customer.pause_start_date,
        pause_resume_date: customer.pause_resume_date,
        status: customer.status,
        active: customer.active,
        menu_style: customer.menu_style || 'Set Menu',
      },
      merchant: {
        id: customer.merchant_id,
        business_name: merchant?.business_name || 'Tiffin Service',
        currency: merchant?.currency || 'AED',
        payment_account_connected: merchant?.payment_account_connected && merchant?.payment_verification_status === 'verified',
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/portal/me - Update customer profile (allowed fields only)
router.put('/me', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    // Whitelist of allowed fields to update
    const allowedFields = ['address', 'area', 'roti_quantity', 'rice_type', 'dietary_preference', 'special_notes', 'skip_weekends'];
    const updateData: any = {};

    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'roti_quantity') {
          updateData[field] = parseInt(req.body[field]) || 2;
        } else if (field === 'skip_weekends') {
          updateData[field] = Boolean(req.body[field]);
        } else {
          updateData[field] = req.body[field];
        }
      }
    }

    if (Object.keys(updateData).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    const updated = await prisma.customer.update({
      where: { id: customer.id },
      data: updateData,
    });

    // Notify merchant about profile changes
    const merchant = await prisma.user.findUnique({ where: { id: customer.created_by } });
    if (merchant) {
      const changedFields = Object.keys(updateData).map(f => `<li><strong>${f.replace(/_/g, ' ')}:</strong> ${updateData[f]}</li>`).join('');
      sendEmail({
        to: merchant.email,
        subject: `Customer Profile Updated - ${customer.full_name}`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">Customer Profile Updated</h1>
            </div>
            <div style="background: #fff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
              <p style="font-size: 15px; color: #334155;"><strong>${customer.full_name}</strong> updated their profile via the customer portal:</p>
              <ul style="font-size: 14px; color: #475569; line-height: 1.8;">${changedFields}</ul>
            </div>
          </div>
        `,
      }).catch(err => console.error('[Email] Profile update notification failed:', err));
    }

    res.json({ success: true, customer: updated });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/payments - Get payment history
router.get('/payments', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    const paymentLinks = await prisma.paymentLink.findMany({
      where: { customer_id: customer.id },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    res.json({
      payments: paymentLinks.map((p) => ({
        id: p.id,
        amount: p.amount,
        currency: p.currency,
        description: p.description,
        status: p.status,
        paid_at: p.paid_at,
        created_at: p.created_at,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/renew - Create subscription renewal checkout
router.post('/renew', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;
    const merchant = await prisma.user.findUnique({ where: { id: customer.merchant_id } });

    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    if (!merchant.stripe_connect_account_id || !merchant.payment_account_connected || merchant.payment_verification_status !== 'verified') {
      return res.status(400).json({ error: 'Online payments are not available. Please contact your provider.' });
    }

    const amount = req.body.amount || customer.payment_amount || 0;
    if (amount <= 0) {
      return res.status(400).json({ error: 'Invalid payment amount' });
    }

    const currency = (merchant.currency || 'aed').toLowerCase();
    const feePercentage = merchant.fee_percentage || 3.5;
    const platformFeeAmount = Math.round((amount * feePercentage) / 100);
    const netAmount = amount - platformFeeAmount;

    const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency,
            product_data: { name: `Subscription Renewal - ${merchant.business_name || 'Tiffin Service'}` },
            unit_amount: Math.round(amount * 100),
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        application_fee_amount: Math.round(platformFeeAmount * 100),
        metadata: { customer_id: customer.id, merchant_email: merchant.email, payment_type: 'renewal' },
      },
      metadata: {
        customer_id: customer.id,
        customer_owner_email: merchant.email,
        amount: amount.toString(),
        payment_type: 'renewal',
      },
      success_url: `${appUrl}/portal/payment-success?type=renewal`,
      cancel_url: `${appUrl}/portal/dashboard?cancelled=true`,
    }, { stripeAccount: merchant.stripe_connect_account_id ?? undefined });

    // Create payment link record
    await prisma.paymentLink.create({
      data: {
        customer_id: customer.id,
        customer_name: customer.full_name,
        amount,
        currency: currency.toUpperCase(),
        description: `Subscription Renewal`,
        status: 'pending',
        stripe_checkout_session_id: session.id,
        checkout_url: session.url,
        expires_at: new Date(Date.now() + 24 * 60 * 60 * 1000),
        platform_fee_amount: platformFeeAmount,
        net_amount: netAmount,
        payment_metadata: { payment_type: 'renewal' },
        created_by: customer.merchant_id,
      },
    });

    res.json({ success: true, checkoutUrl: session.url, amount, currency: currency.toUpperCase() });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/pause - Pause subscription
router.post('/pause', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;
    const { pause_start, pause_end } = req.body;

    if (!pause_start || !pause_end) {
      return res.status(400).json({ error: 'Pause start and end dates are required' });
    }

    const startDate = parseISO(pause_start);
    const endDate = parseISO(pause_end);
    const today = new Date();

    if (startDate < today) {
      return res.status(400).json({ error: 'Pause start date cannot be in the past' });
    }

    if (endDate <= startDate) {
      return res.status(400).json({ error: 'Pause end date must be after start date' });
    }

    const pauseDays = differenceInDays(endDate, startDate);
    if (pauseDays > 30) {
      return res.status(400).json({ error: 'Maximum pause duration is 30 days' });
    }

    // Calculate new end date by extending by pause days
    const currentEndDate = customer.end_date ? new Date(customer.end_date) : null;
    const newEndDate = currentEndDate ? addDays(currentEndDate, pauseDays) : null;

    // Build pause history
    const pauseHistory = customer.pause_history || [];
    (pauseHistory as any[]).push({
      pause_start: pause_start,
      pause_end: pause_end,
      pause_days: pauseDays,
      created_at: new Date().toISOString(),
    });

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        is_paused: true,
        pause_start_date: pause_start,
        pause_resume_date: pause_end,
        original_end_date: customer.end_date ? format(customer.end_date, 'yyyy-MM-dd') : null,
        total_pause_days: (customer.total_pause_days || 0) + pauseDays,
        pause_history: pauseHistory,
        end_date: newEndDate,
        status: 'paused',
      },
    });

    // Notify merchant
    const merchant = await prisma.user.findUnique({ where: { id: customer.merchant_id } });
    if (merchant) {
      await prisma.notification.create({
        data: {
          user_email: merchant.email,
          title: 'Customer Paused Subscription',
          message: `${customer.full_name} has paused their subscription from ${pause_start} to ${pause_end}`,
          type: 'pause',
          notification_type: 'info',
          customer_id: customer.id,
          customer_name: customer.full_name,
        },
      });
    }

    res.json({
      success: true,
      message: `Subscription paused from ${pause_start} to ${pause_end}`,
      pause_days: pauseDays,
      new_end_date: newEndDate ? format(newEndDate, 'yyyy-MM-dd') : null,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/resume - Resume paused subscription
router.post('/resume', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    if (!customer.is_paused) {
      return res.status(400).json({ error: 'Subscription is not paused' });
    }

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        is_paused: false,
        pause_start_date: null,
        pause_resume_date: null,
        status: 'active',
      },
    });

    res.json({ success: true, message: 'Subscription resumed successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/menu - Get merchant's active menu items
router.get('/menu', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    // Orderable items (à la carte or any item with price > 0)
    const orderableItems = await prisma.menuItem.findMany({
      where: { created_by: customer.merchant_id, is_active: true, price: { gt: 0 } },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    // Today's set menu (informational)
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const today = dayNames[new Date().getDay()];
    const todaysSetMenu = await prisma.menuItem.findMany({
      where: {
        created_by: customer.merchant_id,
        is_active: true,
        day_of_week: today,
        menu_type: { not: 'ala_carte' },
      },
      orderBy: [{ meal_type: 'asc' }, { name: 'asc' }],
    });

    const merchant = await prisma.user.findUnique({ where: { id: customer.merchant_id } });

    res.json({
      menu: orderableItems.map((m) => ({
        id: m.id,
        name: m.name || m.item_name,
        description: m.description,
        price: m.price,
        category: m.category,
        meal_type: m.meal_type,
        image_url: m.image_url,
      })),
      todays_set_menu: todaysSetMenu.map((m) => ({
        id: m.id,
        name: m.name || m.item_name,
        description: m.description,
        meal_type: m.meal_type,
        diet_type: m.diet_type,
      })),
      stripe_connected: !!(merchant?.stripe_connect_account_id && merchant?.payment_account_connected && merchant?.payment_verification_status === 'verified'),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/orders - List one-time orders
router.get('/orders', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    const orders = await prisma.oneTimeOrder.findMany({
      where: { customer_id: customer.id },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    res.json({
      orders: orders.map((o) => ({
        id: o.id,
        items: o.items,
        total_amount: o.total_amount,
        currency: o.currency,
        delivery_date: o.delivery_date,
        delivery_time: o.delivery_time,
        special_notes: o.special_notes,
        status: o.status,
        payment_status: o.payment_status,
        created_at: o.created_at,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/orders - Create one-time order with Stripe checkout
router.post('/orders', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;
    const { items, delivery_date, delivery_time, special_notes, payment_method } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Items are required' });
    }

    const merchant = await prisma.user.findUnique({ where: { id: customer.merchant_id } });
    if (!merchant) {
      return res.status(404).json({ error: 'Merchant not found' });
    }

    const isCash = payment_method === 'cash';

    if (!isCash) {
      if (!merchant.stripe_connect_account_id || !merchant.payment_account_connected || merchant.payment_verification_status !== 'verified') {
        return res.status(400).json({ error: 'Online payments are not available. Please contact your provider.' });
      }
    }

    // Validate and calculate items
    const menuItemIds = items.map((i: any) => i.menu_item_id);
    const menuItems = await prisma.menuItem.findMany({
      where: { id: { in: menuItemIds }, created_by: customer.merchant_id, is_active: true },
    });

    const menuItemMap = new Map(menuItems.map((m) => [m.id, m]));
    const orderItems: any[] = [];
    let totalAmount = 0;

    for (const item of items) {
      const menuItem = menuItemMap.get(item.menu_item_id);
      if (!menuItem) {
        return res.status(400).json({ error: `Menu item not found: ${item.menu_item_id}` });
      }
      const quantity = parseInt(item.quantity) || 1;
      const price = menuItem.price || 0;
      orderItems.push({
        menu_item_id: menuItem.id,
        name: menuItem.name,
        quantity,
        price,
      });
      totalAmount += price * quantity;
    }

    if (totalAmount <= 0) {
      return res.status(400).json({ error: 'Order total must be greater than 0' });
    }

    const currency = (merchant.currency || 'aed').toLowerCase();

    // Cash payment — no Stripe, no platform fee
    if (isCash) {
      const order = await prisma.oneTimeOrder.create({
        data: {
          customer_id: customer.id,
          customer_name: customer.full_name,
          items: orderItems,
          total_amount: totalAmount,
          currency: currency.toUpperCase(),
          delivery_date,
          delivery_time,
          special_notes,
          status: 'confirmed',
          payment_status: 'cash',
          platform_fee: 0,
          net_amount: totalAmount,
          created_by: customer.merchant_id,
        },
      });

      // Notify merchant
      await prisma.notification.create({
        data: {
          user_email: merchant.email,
          title: 'New Cash Order',
          message: `${customer.full_name} placed a cash order for ${currency.toUpperCase()} ${totalAmount.toFixed(2)}`,
          type: 'order',
          notification_type: 'info',
          customer_id: customer.id,
          customer_name: customer.full_name,
        },
      });

      // Email merchant about new extra order
      const itemsList = orderItems.map((it: any) => `${it.name} x${it.quantity} — ${currency.toUpperCase()} ${(it.price * it.quantity).toFixed(2)}`).join('<br/>');
      sendEmail({
        to: merchant.email,
        subject: `New Extra Order - ${customer.full_name} (Cash)`,
        body: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">New Extra Order</h1>
            </div>
            <div style="background: #fff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
              <p style="font-size: 15px; color: #334155;"><strong>${customer.full_name}</strong> placed a cash order:</p>
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 16px 0;">
                <p style="font-size: 14px; color: #475569; line-height: 1.8; margin: 0;">${itemsList}</p>
                <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 12px 0;" />
                <p style="font-size: 16px; font-weight: bold; color: #334155; margin: 0;">Total: ${currency.toUpperCase()} ${totalAmount.toFixed(2)}</p>
              </div>
              <p style="font-size: 14px; color: #475569;"><strong>Payment:</strong> Cash</p>
              ${delivery_date ? `<p style="font-size: 14px; color: #475569;"><strong>Delivery:</strong> ${delivery_date}${delivery_time ? ' at ' + delivery_time : ''}</p>` : ''}
              ${special_notes ? `<p style="font-size: 14px; color: #475569;"><strong>Notes:</strong> ${special_notes}</p>` : ''}
            </div>
          </div>
        `,
      }).catch(err => console.error('[Email] Extra order notification failed:', err));

      return res.json({
        success: true,
        order_id: order.id,
        cash: true,
        total_amount: totalAmount,
        currency: currency.toUpperCase(),
      });
    }

    // Card payment — Stripe checkout
    const feePercentage = merchant.fee_percentage || 3.5;
    const platformFeeAmount = Math.round((totalAmount * feePercentage) / 100);
    const netAmount = totalAmount - platformFeeAmount;

    const order = await prisma.oneTimeOrder.create({
      data: {
        customer_id: customer.id,
        customer_name: customer.full_name,
        items: orderItems,
        total_amount: totalAmount,
        currency: currency.toUpperCase(),
        delivery_date,
        delivery_time,
        special_notes,
        status: 'pending',
        payment_status: 'pending',
        platform_fee: platformFeeAmount,
        net_amount: netAmount,
        created_by: customer.merchant_id,
      },
    });

    const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: orderItems.map((item) => ({
        price_data: {
          currency,
          product_data: { name: item.name },
          unit_amount: Math.round(item.price * 100),
        },
        quantity: item.quantity,
      })),
      payment_intent_data: {
        application_fee_amount: Math.round(platformFeeAmount * 100),
        metadata: {
          customer_id: customer.id,
          merchant_email: merchant.email,
          payment_type: 'one_time_order',
          order_id: order.id,
        },
      },
      metadata: {
        customer_id: customer.id,
        customer_owner_email: merchant.email,
        payment_type: 'one_time_order',
        order_id: order.id,
      },
      success_url: `${appUrl}/portal/payment-success?type=order&order_id=${order.id}`,
      cancel_url: `${appUrl}/portal/orders?cancelled=true`,
    }, { stripeAccount: merchant.stripe_connect_account_id ?? undefined });

    await prisma.oneTimeOrder.update({
      where: { id: order.id },
      data: { stripe_session_id: session.id },
    });

    res.json({
      success: true,
      order_id: order.id,
      checkoutUrl: session.url,
      total_amount: totalAmount,
      currency: currency.toUpperCase(),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/skips - Get customer's skips (authenticated)
router.get('/skips', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    const skips = await prisma.tiffinSkip.findMany({
      where: { customer_id: customer.id },
      orderBy: { created_at: 'desc' },
      take: 30,
    });

    res.json({
      skips: skips.map((s) => ({
        id: s.id,
        skip_date: s.skip_date,
        meal_type: s.meal_type,
        status: s.status,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/skips - Create a skip (authenticated)
router.post('/skips', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;
    const { skip_date, meal_type } = req.body;

    if (!skip_date) {
      return res.status(400).json({ error: 'skip_date is required' });
    }

    // Check if skip already exists
    const existing = await prisma.tiffinSkip.findFirst({
      where: {
        customer_id: customer.id,
        skip_date,
        meal_type: meal_type || customer.meal_type || 'Lunch',
        status: 'active',
      },
    });

    if (existing) {
      return res.status(400).json({ error: 'Already skipped for this date' });
    }

    const skip = await prisma.tiffinSkip.create({
      data: {
        customer_id: customer.id,
        customer_name: customer.full_name,
        skip_date,
        meal_type: meal_type || customer.meal_type || 'Lunch',
        reason: 'Customer portal request',
        status: 'active',
        created_by: customer.merchant_id,
      },
    });

    res.json({ success: true, skip: { id: skip.id, skip_date: skip.skip_date, meal_type: skip.meal_type } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/portal/skips/:skipId - Cancel a skip (authenticated)
router.delete('/skips/:skipId', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const customer = req.customer!;

    const skip = await prisma.tiffinSkip.findFirst({
      where: { id: req.params.skipId as string, customer_id: customer.id },
    });

    if (!skip) {
      return res.status(404).json({ error: 'Skip not found' });
    }

    await prisma.tiffinSkip.update({
      where: { id: skip.id },
      data: { status: 'cancelled' },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─────────────────────────────────────────────────────────────────
// PUBLIC ENDPOINTS (No auth required)
// ─────────────────────────────────────────────────────────────────

// ─── GET /api/portal/join/:merchantId — Public registration form data ───
router.get('/join/:merchantId', async (req: Request, res: Response) => {
  try {
    const merchant = await prisma.user.findUnique({ where: { id: req.params.merchantId as string } });
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    res.json({
      business_name: merchant.business_name || 'Tiffin Service',
      currency: merchant.currency || 'AED',
      payment_account_connected: merchant.payment_account_connected && merchant.payment_verification_status === 'verified',
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ─── POST /api/portal/join/:merchantId — Customer self-registration ───
router.post('/join/:merchantId', async (req: Request, res: Response) => {
  try {
    const merchant = await prisma.user.findUnique({ where: { id: req.params.merchantId as string } });
    if (!merchant) return res.status(404).json({ error: 'Merchant not found' });

    const { full_name, phone_number, address, area, meal_type, roti_quantity, rice_type, dietary_preference, special_notes, registration_type } = req.body;

    if (!full_name || !phone_number) {
      return res.status(400).json({ error: 'Name and phone number are required' });
    }

    // Check for duplicate phone
    const existing = await prisma.customer.findFirst({
      where: { created_by: merchant.id, phone_number, is_deleted: false },
    });
    if (existing) {
      return res.status(400).json({ error: 'A customer with this phone number already exists' });
    }

    const isTrial = registration_type === 'trial';

    const customer = await prisma.customer.create({
      data: {
        full_name,
        phone_number,
        address: address || null,
        area: area || null,
        meal_type: meal_type || 'Lunch',
        roti_quantity: roti_quantity ? parseInt(roti_quantity) : 2,
        rice_type: rice_type || 'None',
        dietary_preference: dietary_preference || 'Both',
        special_notes: special_notes || null,
        status: 'pending_verification',
        active: false,
        is_trial: isTrial,
        trial_end_date: isTrial ? addDays(new Date(), 3) : null,
        payment_status: isTrial ? 'Trial' : 'Pending',
        registration_source: 'self_registration',
        created_by: merchant.id,
      },
    });

    // If pay-now and merchant has Stripe connected
    if (!isTrial && merchant.stripe_connect_account_id && merchant.payment_account_connected && merchant.payment_verification_status === 'verified') {
      const amount = req.body.payment_amount || 0;
      if (amount > 0) {
        const currency = (merchant.currency || 'aed').toLowerCase();
        const feePercentage = merchant.fee_percentage || 3.5;
        const platformFeeAmount = Math.round((amount * feePercentage) / 100);
        const appUrl = (process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');

        const session = await stripe.checkout.sessions.create({
          mode: 'payment',
          payment_method_types: ['card'],
          line_items: [{
            price_data: {
              currency,
              product_data: { name: `Tiffin Subscription - ${merchant.business_name || 'Tiffin Service'}` },
              unit_amount: Math.round(amount * 100),
            },
            quantity: 1,
          }],
          payment_intent_data: {
            application_fee_amount: Math.round(platformFeeAmount * 100),
            metadata: { customer_id: customer.id, merchant_email: merchant.email },
          },
          metadata: {
            customer_id: customer.id,
            customer_owner_email: merchant.email,
            amount: amount.toString(),
            registration: 'true',
          },
          success_url: `${appUrl}/registration-success?type=paid`,
          cancel_url: `${appUrl}/join/${merchant.id}?cancelled=true`,
        }, { stripeAccount: merchant.stripe_connect_account_id ?? undefined });

        return res.json({ success: true, checkoutUrl: session.url, customerId: customer.id });
      }
    }

    // Send merchant email notification
    try {
      await sendEmail({
        to: merchant.email,
        subject: `New Customer Registration - ${full_name}`,
        body: `<h2>New Customer Registration</h2>
<p><strong>${full_name}</strong> has registered via your public link.</p>
<p><strong>Phone:</strong> ${phone_number}</p>
<p><strong>Type:</strong> ${isTrial ? '3-Day Free Trial' : 'Direct Registration'}</p>
<p><strong>Meal:</strong> ${meal_type || 'Lunch'}</p>
${address ? `<p><strong>Address:</strong> ${address}</p>` : ''}
<p>Please log in to your dashboard to approve or reject this registration.</p>`,
      });
    } catch (e: any) { console.error('[Portal] Send failed:', e.message); }

    // Create notification
    await prisma.notification.create({
      data: {
        user_email: merchant.email,
        title: 'New Customer Registration',
        message: `${full_name} registered via public link (${isTrial ? 'Trial' : 'Direct'})`,
        type: 'registration',
        notification_type: 'info',
        customer_id: customer.id,
        customer_name: full_name,
        phone_number,
      },
    });

    res.json({ success: true, customerId: customer.id, type: isTrial ? 'trial' : 'direct' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/portal/:token - Get customer info
router.get('/:token', async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { portal_token: req.params.token as string, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const owner = await prisma.user.findUnique({ where: { id: customer.created_by } });

    // Get menu items for this merchant
    const menuItems = await prisma.menuItem.findMany({
      where: { created_by: customer.created_by, is_active: true },
    });

    // Get recent skips
    const skips = await prisma.tiffinSkip.findMany({
      where: { customer_id: customer.id },
      orderBy: { created_at: 'desc' },
      take: 30,
    });

    // Get payment links
    const paymentLinks = await prisma.paymentLink.findMany({
      where: { customer_id: customer.id, status: 'pending' },
      orderBy: { created_at: 'desc' },
      take: 5,
    });

    res.json({
      customer: {
        full_name: customer.full_name,
        meal_type: customer.meal_type,
        payment_amount: customer.payment_amount,
        payment_status: customer.payment_status,
        start_date: customer.start_date,
        end_date: customer.end_date,
        days_remaining: customer.days_remaining,
        paid_days: customer.paid_days,
        delivered_days: customer.delivered_days,
        roti_quantity: customer.roti_quantity,
        rice_type: customer.rice_type,
        dietary_preference: customer.dietary_preference,
        skip_weekends: customer.skip_weekends,
        is_paused: customer.is_paused,
        status: customer.status,
        active: customer.active,
      },
      business: {
        name: (owner as any)?.business_name || 'Tiffin Service',
      },
      menu: menuItems.map(m => ({
        name: m.name,
        description: m.description,
        price: m.price,
        category: m.category,
        meal_type: m.meal_type,
        image_url: m.image_url,
      })),
      skips: skips.map(s => ({
        id: s.id,
        skip_date: s.skip_date,
        meal_type: s.meal_type,
        status: s.status,
      })),
      pendingPayments: paymentLinks.map(p => ({
        amount: p.amount,
        currency: p.currency,
        checkout_url: p.checkout_url,
        description: p.description,
      })),
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/portal/:token/skip - Skip a day
router.post('/:token/skip', async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { portal_token: req.params.token as string, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const { skip_date, meal_type } = req.body;
    if (!skip_date) return res.status(400).json({ error: 'skip_date required' });

    // Check if skip already exists
    const existing = await prisma.tiffinSkip.findFirst({
      where: {
        customer_id: customer.id,
        skip_date,
        meal_type: meal_type || customer.meal_type || 'Lunch',
        status: 'active',
      },
    });
    if (existing) return res.status(400).json({ error: 'Already skipped for this date' });

    const skip = await prisma.tiffinSkip.create({
      data: {
        customer_id: customer.id,
        customer_name: customer.full_name,
        skip_date,
        meal_type: meal_type || customer.meal_type || 'Lunch',
        reason: 'Customer self-service portal',
        status: 'active',
        created_by: customer.created_by,
      },
    });

    res.json({ success: true, skip: { id: skip.id, skip_date: skip.skip_date, meal_type: skip.meal_type } });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/portal/:token/skip/:skipId - Cancel a skip
router.delete('/:token/skip/:skipId', async (req: Request, res: Response) => {
  try {
    const customer = await prisma.customer.findFirst({
      where: { portal_token: req.params.token as string, is_deleted: false },
    });
    if (!customer) return res.status(404).json({ error: 'Not found' });

    const skip = await prisma.tiffinSkip.findFirst({
      where: { id: req.params.skipId as string, customer_id: customer.id },
    });
    if (!skip) return res.status(404).json({ error: 'Skip not found' });

    await prisma.tiffinSkip.update({
      where: { id: skip.id },
      data: { status: 'cancelled' },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
