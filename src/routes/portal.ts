import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { format, addDays } from 'date-fns';
import { sendEmail } from '../services/email';
import { stripe } from '../services/stripe';

const router = Router();

// Public endpoints - no auth required

// ─── GET /api/portal/join/:merchantId — Public registration form data ───
router.get('/join/:merchantId', async (req: Request, res: Response) => {
  try {
    const merchant = await prisma.user.findUnique({ where: { id: req.params.merchantId } });
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
    const merchant = await prisma.user.findUnique({ where: { id: req.params.merchantId } });
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
        }, { stripeAccount: merchant.stripe_connect_account_id });

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
    } catch {}

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
