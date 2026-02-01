"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const prisma_1 = require("../lib/prisma");
const stripe_1 = require("../services/stripe");
const email_1 = require("../services/email");
const whatsapp_1 = require("../services/whatsapp");
const router = (0, express_1.Router)();
// POST /api/webhooks/stripe
router.post('/stripe', async (req, res) => {
    const signature = req.headers['stripe-signature'];
    if (!signature)
        return res.status(400).json({ error: 'No signature' });
    let event;
    try {
        event = stripe_1.stripe.webhooks.constructEvent(req.body, signature, stripe_1.STRIPE_WEBHOOK_SECRET);
    }
    catch (err) {
        console.error('Webhook signature verification failed:', err.message);
        return res.status(400).json({ error: 'Invalid signature' });
    }
    try {
        switch (event.type) {
            case 'checkout.session.completed': {
                const session = event.data.object;
                const userEmail = session.metadata?.user_email;
                const customerId = session.metadata?.customer_id;
                // Handle customer tiffin payment
                if (customerId) {
                    const customerOwnerEmail = session.metadata?.customer_owner_email;
                    if (!customerOwnerEmail)
                        break;
                    const ownerUser = await prisma_1.prisma.user.findUnique({ where: { email: customerOwnerEmail } });
                    if (!ownerUser)
                        break;
                    const customer = await prisma_1.prisma.customer.findFirst({
                        where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
                    });
                    if (customer) {
                        const amount = session.amount_total / 100;
                        await prisma_1.prisma.customer.update({
                            where: { id: customer.id },
                            data: {
                                payment_status: 'Paid',
                                last_payment_date: new Date(),
                                last_payment_amount: amount,
                                status: 'active',
                                active: true,
                                inactive_reason: null,
                                reminder_before_sent: false,
                                reminder_after_sent: false,
                            },
                        });
                        if (customer.phone_number) {
                            try {
                                await (0, whatsapp_1.sendWhatsAppMessage)({
                                    to: customer.phone_number,
                                    message: `✅ *Payment Received*\n\nHello ${customer.full_name},\n\nPayment of AED ${amount} received!\n\nThank you!`,
                                });
                            }
                            catch { }
                        }
                        await (0, email_1.sendEmail)({
                            to: customerOwnerEmail,
                            subject: `✅ Payment Received - ${customer.full_name}`,
                            body: `<h2>Payment Confirmed</h2><p>${customer.full_name} paid AED ${amount}</p>`,
                        });
                        // Update payment link
                        const paymentLinks = await prisma_1.prisma.paymentLink.findMany({
                            where: { customer_id: customerId, created_by: ownerUser.id, stripe_checkout_session_id: session.id },
                        });
                        if (paymentLinks.length > 0) {
                            await prisma_1.prisma.paymentLink.update({
                                where: { id: paymentLinks[0].id },
                                data: { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: session.payment_intent },
                            });
                        }
                    }
                    break;
                }
                // Handle platform subscription
                if (session.mode === 'subscription' && userEmail) {
                    const subscription = await stripe_1.stripe.subscriptions.retrieve(session.subscription);
                    const user = await prisma_1.prisma.user.findUnique({ where: { email: userEmail } });
                    if (!user)
                        break;
                    // Don't override admin-assigned plans
                    if (user.subscription_source === 'admin')
                        break;
                    // Upsert subscription record
                    const existingSubs = await prisma_1.prisma.subscription.findMany({ where: { user_email: userEmail } });
                    const subData = {
                        user_email: userEmail,
                        plan_name: 'Premium Plan',
                        status: 'active',
                        subscription_start_date: new Date(subscription.current_period_start * 1000),
                        next_billing_date: new Date(subscription.current_period_end * 1000),
                        current_period_end: new Date(subscription.current_period_end * 1000),
                        amount: 60.00,
                        stripe_customer_id: subscription.customer,
                        stripe_subscription_id: subscription.id,
                        reminder_before_sent: false,
                        reminder_after_sent: false,
                    };
                    if (existingSubs.length > 0) {
                        await prisma_1.prisma.subscription.update({ where: { id: existingSubs[0].id }, data: subData });
                    }
                    else {
                        await prisma_1.prisma.subscription.create({ data: subData });
                    }
                    // Payment history
                    await prisma_1.prisma.paymentHistory.create({
                        data: {
                            user_email: userEmail,
                            subscription_id: subscription.id,
                            amount: 60.00,
                            currency: 'AED',
                            status: 'succeeded',
                            payment_date: new Date(),
                            stripe_payment_id: session.payment_intent,
                        },
                    });
                    // Update user
                    await prisma_1.prisma.user.update({
                        where: { id: user.id },
                        data: {
                            subscription_status: 'active',
                            plan_type: 'premium',
                            subscription_source: 'stripe',
                            is_paid: true,
                            stripe_customer_id: subscription.customer,
                            stripe_subscription_id: subscription.id,
                            current_period_end: new Date(subscription.current_period_end * 1000),
                            subscription_ends_at: new Date(subscription.current_period_end * 1000),
                            next_billing_date: new Date(subscription.current_period_end * 1000),
                            last_payment_status: 'succeeded',
                            trial_ends_at: null,
                            trial_cancelled_at: new Date(),
                        },
                    });
                    await (0, email_1.sendEmail)({
                        to: userEmail,
                        subject: '✅ Payment Confirmed - TiffinHub Manager',
                        body: `Your Premium subscription is now active. Next billing: ${new Date(subscription.current_period_end * 1000).toLocaleDateString()}`,
                    });
                }
                break;
            }
            case 'invoice.payment_succeeded': {
                const invoice = event.data.object;
                const customerId = invoice.metadata?.customer_id;
                if (customerId) {
                    // Customer tiffin payment - same as checkout.session.completed for customer
                    const customerOwnerEmail = invoice.metadata?.customer_owner_email;
                    if (customerOwnerEmail) {
                        const ownerUser = await prisma_1.prisma.user.findUnique({ where: { email: customerOwnerEmail } });
                        if (ownerUser) {
                            const customer = await prisma_1.prisma.customer.findFirst({
                                where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
                            });
                            if (customer) {
                                const amount = invoice.amount_paid / 100;
                                await prisma_1.prisma.customer.update({
                                    where: { id: customer.id },
                                    data: { payment_status: 'Paid', last_payment_date: new Date(), last_payment_amount: amount, status: 'active', active: true, reminder_before_sent: false, reminder_after_sent: false },
                                });
                            }
                        }
                    }
                    break;
                }
                // Platform subscription renewal
                if (invoice.subscription) {
                    const subscription = await stripe_1.stripe.subscriptions.retrieve(invoice.subscription);
                    const subs = await prisma_1.prisma.subscription.findMany({ where: { stripe_subscription_id: invoice.subscription } });
                    if (subs.length > 0) {
                        const sub = subs[0];
                        await prisma_1.prisma.subscription.update({
                            where: { id: sub.id },
                            data: {
                                status: 'active',
                                next_billing_date: new Date(subscription.current_period_end * 1000),
                                current_period_end: new Date(subscription.current_period_end * 1000),
                                reminder_before_sent: false,
                                reminder_after_sent: false,
                            },
                        });
                        await prisma_1.prisma.paymentHistory.create({
                            data: {
                                user_email: sub.user_email,
                                subscription_id: invoice.subscription,
                                amount: invoice.amount_paid / 100,
                                currency: invoice.currency?.toUpperCase(),
                                status: 'succeeded',
                                payment_date: new Date(invoice.created * 1000),
                                stripe_payment_id: invoice.payment_intent,
                            },
                        });
                        const user = await prisma_1.prisma.user.findUnique({ where: { email: sub.user_email } });
                        if (user && user.subscription_source !== 'admin') {
                            await prisma_1.prisma.user.update({
                                where: { id: user.id },
                                data: {
                                    subscription_status: 'active',
                                    plan_type: 'premium',
                                    is_paid: true,
                                    current_period_end: new Date(subscription.current_period_end * 1000),
                                    subscription_ends_at: new Date(subscription.current_period_end * 1000),
                                    last_payment_status: 'succeeded',
                                },
                            });
                        }
                    }
                }
                break;
            }
            case 'invoice.payment_failed': {
                const invoice = event.data.object;
                const customerId = invoice.metadata?.customer_id;
                if (customerId) {
                    const customerOwnerEmail = invoice.metadata?.customer_owner_email;
                    if (customerOwnerEmail) {
                        const ownerUser = await prisma_1.prisma.user.findUnique({ where: { email: customerOwnerEmail } });
                        if (ownerUser) {
                            const customer = await prisma_1.prisma.customer.findFirst({
                                where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
                            });
                            if (customer) {
                                await prisma_1.prisma.customer.update({
                                    where: { id: customer.id },
                                    data: { payment_status: 'Overdue', status: 'inactive', active: false, inactive_reason: 'payment_failed' },
                                });
                            }
                        }
                    }
                    break;
                }
                if (invoice.subscription) {
                    const subs = await prisma_1.prisma.subscription.findMany({ where: { stripe_subscription_id: invoice.subscription } });
                    if (subs.length > 0) {
                        const sub = subs[0];
                        await prisma_1.prisma.subscription.update({ where: { id: sub.id }, data: { status: 'past_due' } });
                        await prisma_1.prisma.paymentHistory.create({
                            data: {
                                user_email: sub.user_email,
                                subscription_id: invoice.subscription,
                                amount: invoice.amount_due / 100,
                                currency: invoice.currency?.toUpperCase(),
                                status: 'failed',
                                payment_date: new Date(invoice.created * 1000),
                                stripe_payment_id: invoice.payment_intent,
                                error_message: invoice.last_payment_error?.message || 'Payment failed',
                            },
                        });
                        const user = await prisma_1.prisma.user.findUnique({ where: { email: sub.user_email } });
                        if (user) {
                            await prisma_1.prisma.user.update({
                                where: { id: user.id },
                                data: { subscription_status: 'past_due', is_paid: false, last_payment_status: 'failed' },
                            });
                        }
                        await (0, email_1.sendEmail)({
                            to: sub.user_email,
                            subject: '⚠️ Payment Failed - TiffinHub Manager',
                            body: `Your subscription payment failed. Please update your payment method in the Billing page.`,
                        });
                    }
                }
                break;
            }
            case 'customer.subscription.updated': {
                const subscription = event.data.object;
                const subs = await prisma_1.prisma.subscription.findMany({ where: { stripe_subscription_id: subscription.id } });
                if (subs.length > 0) {
                    const sub = subs[0];
                    await prisma_1.prisma.subscription.update({
                        where: { id: sub.id },
                        data: {
                            status: subscription.status,
                            next_billing_date: new Date(subscription.current_period_end * 1000),
                            current_period_end: new Date(subscription.current_period_end * 1000),
                        },
                    });
                    const user = await prisma_1.prisma.user.findUnique({ where: { email: sub.user_email } });
                    if (user && user.subscription_source !== 'admin') {
                        await prisma_1.prisma.user.update({
                            where: { id: user.id },
                            data: {
                                subscription_status: subscription.status,
                                plan_type: 'premium',
                                is_paid: subscription.status === 'active',
                                current_period_end: new Date(subscription.current_period_end * 1000),
                                subscription_ends_at: new Date(subscription.current_period_end * 1000),
                            },
                        });
                    }
                }
                break;
            }
            case 'customer.subscription.deleted': {
                const subscription = event.data.object;
                const subs = await prisma_1.prisma.subscription.findMany({ where: { stripe_subscription_id: subscription.id } });
                if (subs.length > 0) {
                    const sub = subs[0];
                    await prisma_1.prisma.subscription.update({
                        where: { id: sub.id },
                        data: { status: 'cancelled', cancelled_at: new Date() },
                    });
                    const user = await prisma_1.prisma.user.findUnique({ where: { email: sub.user_email } });
                    if (user && user.subscription_status !== 'cancelled') {
                        await prisma_1.prisma.user.update({
                            where: { id: user.id },
                            data: { subscription_status: 'cancelled', is_paid: false, plan_type: 'none', last_payment_status: 'cancelled' },
                        });
                    }
                    await (0, email_1.sendEmail)({
                        to: sub.user_email,
                        subject: 'Subscription Cancelled - TiffinHub Manager',
                        body: `Your subscription has been cancelled. You can reactivate from the Billing page.`,
                    });
                }
                break;
            }
        }
        res.json({ received: true });
    }
    catch (error) {
        console.error('Error processing webhook:', error);
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=webhooks.js.map