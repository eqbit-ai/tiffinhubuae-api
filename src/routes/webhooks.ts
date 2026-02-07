import { Router, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { stripe, STRIPE_WEBHOOK_SECRET } from '../services/stripe';
import { sendEmail } from '../services/email';
import { sendWhatsAppMessage } from '../services/whatsapp';
import { addMonths, format } from 'date-fns';

const router = Router();

// POST /api/webhooks/stripe
router.post('/stripe', async (req: Request, res: Response) => {
  const signature = req.headers['stripe-signature'] as string;
  if (!signature) return res.status(400).json({ error: 'No signature' });

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err: any) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).json({ error: 'Invalid signature' });
  }

  try {
    console.log(`[Webhook] Received event: ${event.type} (id: ${event.id})`);

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as any;
        const userEmail = session.metadata?.user_email;
        const customerId = session.metadata?.customer_id;
        console.log(`[Webhook] checkout.session.completed — session: ${session.id}, userEmail: ${userEmail}, customerId: ${customerId}, mode: ${session.mode}, payment_type: ${session.metadata?.payment_type}`);

        // Handle self-registration payment
        if (customerId && session.metadata?.registration === 'true') {
          const customerOwnerEmail = session.metadata?.customer_owner_email;
          console.log(`[Webhook] Registration payment — customerId: ${customerId}, ownerEmail: ${customerOwnerEmail}`);
          if (!customerOwnerEmail) { console.log('[Webhook] No customer_owner_email in metadata, skipping'); break; }

          const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
          if (!ownerUser) { console.log(`[Webhook] Owner user not found: ${customerOwnerEmail}`); break; }

          const customer = await prisma.customer.findFirst({
            where: { id: customerId, created_by: ownerUser.id },
          });

          if (customer) {
            const amount = session.amount_total / 100;
            console.log(`[Webhook] Updating registration payment for customer ${customer.full_name} — amount: ${amount}`);
            await prisma.customer.update({
              where: { id: customer.id },
              data: {
                payment_status: 'Paid',
                last_payment_date: new Date(),
                last_payment_amount: amount,
                payment_amount: amount,
                start_date: new Date(),
                end_date: addMonths(new Date(), 1),
                paid_days: 30,
                delivered_days: 0,
                days_remaining: 30,
                // Still pending_verification until merchant approves
              },
            });

            await sendEmail({
              to: customerOwnerEmail,
              subject: `New Paid Registration - ${customer.full_name}`,
              body: `<h2>New Paid Customer Registration</h2>
<p><strong>${customer.full_name}</strong> has registered and paid <strong>${(session.currency || 'aed').toUpperCase()} ${amount}</strong>.</p>
<p>Please approve their registration in your dashboard.</p>`,
            });
          } else {
            console.log(`[Webhook] Customer not found for registration — customerId: ${customerId}, ownerId: ${ownerUser.id}`);
          }
          break;
        }

        // Handle one-time order payment
        if (session.metadata?.payment_type === 'one_time_order') {
          const orderId = session.metadata?.order_id;
          const customerOwnerEmail = session.metadata?.customer_owner_email;
          console.log(`[Webhook] One-time order payment — orderId: ${orderId}, ownerEmail: ${customerOwnerEmail}`);
          if (!orderId || !customerOwnerEmail) { console.log('[Webhook] Missing orderId or customer_owner_email, skipping'); break; }

          const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
          if (!ownerUser) { console.log(`[Webhook] Owner user not found for order: ${customerOwnerEmail}`); break; }

          const order = await prisma.oneTimeOrder.findFirst({
            where: { id: orderId, created_by: ownerUser.id },
          });

          if (order) {
            console.log(`[Webhook] Updating one-time order ${orderId} to paid`);
            await prisma.oneTimeOrder.update({
              where: { id: order.id },
              data: { status: 'paid', payment_status: 'paid' },
            });

            const customer = await prisma.customer.findFirst({
              where: { id: order.customer_id },
            });

            // Notify merchant
            await prisma.notification.create({
              data: {
                user_email: customerOwnerEmail,
                title: 'New Order Received',
                message: `${order.customer_name} placed an order for ${(order.currency || 'AED')} ${order.total_amount}`,
                type: 'order',
                notification_type: 'info',
                customer_id: order.customer_id,
                customer_name: order.customer_name,
              },
            });

            // Send WhatsApp to merchant
            if (ownerUser.whatsapp_number && ownerUser.whatsapp_notifications_enabled) {
              try {
                await sendWhatsAppMessage({
                  to: ownerUser.whatsapp_number!,
                  message: `New Order\n\nCustomer: ${order.customer_name}\nAmount: ${order.currency} ${order.total_amount}\nDelivery: ${order.delivery_date || 'TBD'}\n\nPlease check your dashboard.`,
                  templateName: 'NEW_ORDER_MERCHANT',
                  contentVariables: { '1': order.customer_name || 'Customer', '2': order.currency || 'AED', '3': String(order.total_amount), '4': order.delivery_date || 'TBD' },
                });
              } catch (e: any) { console.error('[Webhook] WhatsApp send failed:', e.message); }
            }

            // Confirm to customer
            if (customer?.phone_number) {
              try {
                await sendWhatsAppMessage({
                  to: customer.phone_number,
                  message: `Order Confirmed\n\nThank you ${customer.full_name}!\n\nYour order of ${order.currency} ${order.total_amount} has been confirmed.\n${order.delivery_date ? `Delivery: ${order.delivery_date}` : ''}\n\nThank you!`,
                  templateName: 'ORDER_CONFIRMED',
                  contentVariables: { '1': customer.full_name, '2': order.currency, '3': String(order.total_amount), '4': order.delivery_date ? `Delivery: ${order.delivery_date}` : '' },
                });
              } catch (e: any) { console.error('[Webhook] WhatsApp send failed:', e.message); }
            }
          }
          break;
        }

        // Handle subscription renewal payment
        if (session.metadata?.payment_type === 'renewal') {
          const customerOwnerEmail = session.metadata?.customer_owner_email;
          console.log(`[Webhook] Renewal payment — customerId: ${customerId}, ownerEmail: ${customerOwnerEmail}`);
          if (!customerId || !customerOwnerEmail) { console.log('[Webhook] Missing customerId or customer_owner_email for renewal, skipping'); break; }

          const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
          if (!ownerUser) { console.log(`[Webhook] Owner user not found for renewal: ${customerOwnerEmail}`); break; }

          const customer = await prisma.customer.findFirst({
            where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
          });

          if (customer) {
            const amount = session.amount_total / 100;
            const currency = (session.currency || 'aed').toUpperCase();
            console.log(`[Webhook] Processing renewal for ${customer.full_name} — ${currency} ${amount}`);

            const baseDate = customer.end_date && new Date(customer.end_date) > new Date() ? new Date(customer.end_date) : new Date();
            const newEndDate = addMonths(baseDate, 1);

            await prisma.customer.update({
              where: { id: customer.id },
              data: {
                payment_status: 'Paid',
                last_payment_date: new Date(),
                last_payment_amount: amount,
                status: 'active',
                active: true,
                is_paused: false,
                inactive_reason: null,
                reminder_before_sent: false,
                reminder_after_sent: false,
                end_date: newEndDate,
                due_date: newEndDate,
                paid_days: (customer.paid_days || 0) + 30,
                days_remaining: (customer.days_remaining || 0) + 30,
              },
            });

            const endFormatted = format(newEndDate, 'dd MMM yyyy');

            if (customer.phone_number) {
              try {
                await sendWhatsAppMessage({
                  to: customer.phone_number,
                  message: `Renewal Successful\n\nHello ${customer.full_name},\n\nYour subscription has been renewed!\n\nAmount: ${currency} ${amount}\nValid until: ${endFormatted}\n\nThank you for continuing with us!`,
                  templateName: 'PAYMENT_RECEIVED',
                  contentVariables: { '1': customer.full_name, '2': currency, '3': String(amount), '4': endFormatted },
                });
              } catch (e: any) { console.error('[Webhook] WhatsApp send failed:', e.message); }
            }

            await sendEmail({
              to: customerOwnerEmail,
              subject: `✅ Subscription Renewed - ${customer.full_name}`,
              body: `<h2>Subscription Renewed</h2>
<p><strong>${customer.full_name}</strong> has renewed their subscription.</p>
<p><strong>Amount:</strong> ${currency} ${amount}</p>
<p><strong>Valid until:</strong> ${endFormatted}</p>`,
            });

            // Update payment link
            const paymentLinks = await prisma.paymentLink.findMany({
              where: { customer_id: customerId, created_by: ownerUser.id, stripe_checkout_session_id: session.id },
            });
            if (paymentLinks.length > 0) {
              await prisma.paymentLink.update({
                where: { id: paymentLinks[0].id },
                data: { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: session.payment_intent },
              });
            }
          } else {
            console.log(`[Webhook] Customer not found for renewal — customerId: ${customerId}, ownerId: ${ownerUser.id}`);
          }
          break;
        }

        // Handle trial conversion payment
        if (customerId && session.metadata?.payment_type === 'trial_conversion') {
          const customerOwnerEmail = session.metadata?.customer_owner_email;
          console.log(`[Webhook] Trial conversion payment — customerId: ${customerId}, ownerEmail: ${customerOwnerEmail}`);
          if (!customerOwnerEmail) { console.log('[Webhook] No customer_owner_email for trial conversion, skipping'); break; }

          const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
          if (!ownerUser) { console.log(`[Webhook] Owner user not found for trial conversion: ${customerOwnerEmail}`); break; }

          const customer = await prisma.customer.findFirst({
            where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
          });

          if (customer) {
            const amount = session.amount_total / 100;
            const currency = (session.currency || 'aed').toUpperCase();
            console.log(`[Webhook] Processing trial conversion for ${customer.full_name} — ${currency} ${amount}`);

            const newStartDate = new Date();
            const newEndDate = addMonths(newStartDate, 1);

            await prisma.customer.update({
              where: { id: customer.id },
              data: {
                payment_status: 'Paid',
                last_payment_date: new Date(),
                last_payment_amount: amount,
                status: 'active',
                active: true,
                is_trial: false,
                trial_converted: true,
                inactive_reason: null,
                reminder_before_sent: false,
                reminder_after_sent: false,
                start_date: newStartDate,
                end_date: newEndDate,
                due_date: newEndDate,
                paid_days: 30,
                delivered_days: 0,
                days_remaining: 30,
              },
            });

            const endFormatted = format(newEndDate, 'dd MMM yyyy');

            if (customer.phone_number) {
              try {
                await sendWhatsAppMessage({
                  to: customer.phone_number,
                  message: `Payment Received!\n\nHello ${customer.full_name},\n\nYour payment of ${currency} ${amount} has been received. Your trial has been converted to a full subscription!\n\nActive until: ${endFormatted}\n\nThank you!`,
                  templateName: 'PAYMENT_RECEIVED',
                  contentVariables: { '1': customer.full_name, '2': currency, '3': String(amount), '4': endFormatted },
                });
              } catch (e: any) { console.error('[Webhook] WhatsApp send failed:', e.message); }
            }

            await sendEmail({
              to: customerOwnerEmail,
              subject: `✅ Trial Converted - ${customer.full_name}`,
              body: `<h2>Trial Converted to Paid</h2>
<p><strong>${customer.full_name}</strong> has paid <strong>${currency} ${amount}</strong> and converted from trial to a full subscription.</p>
<p><strong>Subscription:</strong> ${format(newStartDate, 'dd MMM yyyy')} → ${endFormatted}</p>`,
            });

            const paymentLinks = await prisma.paymentLink.findMany({
              where: { customer_id: customerId, created_by: ownerUser.id, stripe_checkout_session_id: session.id },
            });
            if (paymentLinks.length > 0) {
              await prisma.paymentLink.update({
                where: { id: paymentLinks[0].id },
                data: { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: session.payment_intent },
              });
            }
          }
          break;
        }

        // Handle customer tiffin payment (legacy flow)
        if (customerId) {
          const customerOwnerEmail = session.metadata?.customer_owner_email;
          console.log(`[Webhook] Legacy customer payment — customerId: ${customerId}, ownerEmail: ${customerOwnerEmail}`);
          if (!customerOwnerEmail) { console.log('[Webhook] No customer_owner_email in metadata for legacy flow, skipping'); break; }

          const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
          if (!ownerUser) { console.log(`[Webhook] Owner user not found for legacy flow: ${customerOwnerEmail}`); break; }

          const customer = await prisma.customer.findFirst({
            where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
          });

          if (customer) {
            const amount = session.amount_total / 100;
            const currency = (session.currency || 'aed').toUpperCase();
            console.log(`[Webhook] Processing legacy payment for ${customer.full_name} — ${currency} ${amount}`);

            // Extend subscription by 1 month from current end_date (or from today if no end_date)
            const baseDate = customer.end_date && new Date(customer.end_date) > new Date() ? new Date(customer.end_date) : new Date();
            const newStartDate = new Date();
            const newEndDate = addMonths(baseDate, 1);

            await prisma.customer.update({
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
                start_date: newStartDate,
                end_date: newEndDate,
                due_date: newEndDate,
                paid_days: 30,
                delivered_days: 0,
                days_remaining: 30,
              },
            });

            const endFormatted = format(newEndDate, 'dd MMM yyyy');

            if (customer.phone_number) {
              try {
                await sendWhatsAppMessage({
                  to: customer.phone_number,
                  message: `Payment Received\n\nHello ${customer.full_name},\n\nPayment of ${currency} ${amount} received!\n\nYour subscription is now active until ${endFormatted}.\n\nThank you!`,
                  templateName: 'PAYMENT_RECEIVED',
                  contentVariables: { '1': customer.full_name, '2': currency, '3': String(amount), '4': endFormatted },
                });
              } catch (e: any) { console.error('[Webhook] WhatsApp send failed:', e.message); }
            }

            await sendEmail({
              to: customerOwnerEmail,
              subject: `✅ Payment Received - ${customer.full_name}`,
              body: `<h2>Payment Confirmed</h2>
<p><strong>${customer.full_name}</strong> has paid <strong>${currency} ${amount}</strong>.</p>
<p><strong>Subscription renewed:</strong> ${format(newStartDate, 'dd MMM yyyy')} → ${endFormatted}</p>
<p>The customer is now active on your dashboard.</p>`,
            });

            // Update payment link
            const paymentLinks = await prisma.paymentLink.findMany({
              where: { customer_id: customerId, created_by: ownerUser.id, stripe_checkout_session_id: session.id },
            });
            if (paymentLinks.length > 0) {
              await prisma.paymentLink.update({
                where: { id: paymentLinks[0].id },
                data: { status: 'paid', paid_at: new Date(), stripe_payment_intent_id: session.payment_intent },
              });
            }
          } else {
            console.log(`[Webhook] Customer not found for legacy payment — customerId: ${customerId}, ownerId: ${ownerUser.id}`);
          }
          break;
        }

        // Handle platform subscription
        if (session.mode === 'subscription' && userEmail) {
          // Support both old API (session.subscription) and new basil API structure
          const sessionSubscriptionId: string | undefined = typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription?.id;
          console.log(`[Webhook] Platform subscription — userEmail: ${userEmail}, subscriptionId: ${sessionSubscriptionId}`);
          if (!sessionSubscriptionId) { console.log('[Webhook] No subscription ID found on checkout session'); break; }
          const subscription = await stripe.subscriptions.retrieve(sessionSubscriptionId);

          const user = await prisma.user.findUnique({ where: { email: userEmail } });
          if (!user) { console.log(`[Webhook] User not found for platform subscription: ${userEmail}`); break; }

          // Don't override admin-assigned plans
          if (user.subscription_source === 'admin') { console.log(`[Webhook] Skipping — user ${userEmail} has admin-assigned plan`); break; }

          // Upsert subscription record
          const existingSubs = await prisma.subscription.findMany({ where: { user_email: userEmail } });
          const subData = {
            user_email: userEmail,
            plan_name: 'Premium Plan',
            status: 'active',
            subscription_start_date: new Date(subscription.current_period_start * 1000),
            next_billing_date: new Date(subscription.current_period_end * 1000),
            current_period_end: new Date(subscription.current_period_end * 1000),
            amount: 60.00,
            stripe_customer_id: subscription.customer as string,
            stripe_subscription_id: subscription.id,
            reminder_before_sent: false,
            reminder_after_sent: false,
          };

          if (existingSubs.length > 0) {
            await prisma.subscription.update({ where: { id: existingSubs[0].id }, data: subData });
          } else {
            await prisma.subscription.create({ data: subData });
          }

          // Payment history
          await prisma.paymentHistory.create({
            data: {
              user_email: userEmail,
              subscription_id: subscription.id,
              amount: 60.00,
              currency: 'AED',
              status: 'succeeded',
              payment_date: new Date(),
              stripe_payment_id: session.payment_intent as string,
            },
          });

          // Update user
          await prisma.user.update({
            where: { id: user.id },
            data: {
              subscription_status: 'active',
              plan_type: 'premium',
              subscription_source: 'stripe',
              is_paid: true,
              stripe_customer_id: subscription.customer as string,
              stripe_subscription_id: subscription.id,
              current_period_end: new Date(subscription.current_period_end * 1000),
              subscription_ends_at: new Date(subscription.current_period_end * 1000),
              next_billing_date: new Date(subscription.current_period_end * 1000),
              last_payment_status: 'succeeded',
              trial_ends_at: null,
              trial_cancelled_at: new Date(),
            },
          });

          console.log(`[Webhook] Platform subscription activated for ${userEmail}`);

          await sendEmail({
            to: userEmail,
            subject: '✅ Payment Confirmed - TiffinHub Manager',
            body: `Your Premium subscription is now active. Next billing: ${new Date(subscription.current_period_end * 1000).toLocaleDateString()}`,
          });
        } else {
          console.log(`[Webhook] checkout.session.completed — no matching handler (mode: ${session.mode}, userEmail: ${userEmail}, customerId: ${customerId})`);
        }
        break;
      }

      case 'invoice.payment_succeeded': {
        const invoice = event.data.object as any;
        const customerId = invoice.metadata?.customer_id;
        // Support both old API (invoice.subscription) and new basil API (invoice.parent.subscription_details.subscription)
        const invoiceSubscriptionId: string | undefined = invoice.subscription || invoice.parent?.subscription_details?.subscription;
        console.log(`[Webhook] invoice.payment_succeeded — invoiceId: ${invoice.id}, customerId: ${customerId}, subscriptionId: ${invoiceSubscriptionId}`);

        if (customerId) {
          // Customer tiffin payment - same as checkout.session.completed for customer
          const customerOwnerEmail = invoice.metadata?.customer_owner_email;
          if (customerOwnerEmail) {
            const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
            if (ownerUser) {
              const customer = await prisma.customer.findFirst({
                where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
              });
              if (customer) {
                const amount = invoice.amount_paid / 100;
                const baseDate = customer.end_date && new Date(customer.end_date) > new Date() ? new Date(customer.end_date) : new Date();
                const newEndDate = addMonths(baseDate, 1);

                await prisma.customer.update({
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
                    start_date: new Date(),
                    end_date: newEndDate,
                    due_date: newEndDate,
                    paid_days: 30,
                    delivered_days: 0,
                    days_remaining: 30,
                  },
                });
              }
            }
          }
          break;
        }

        // Platform subscription renewal
        if (invoiceSubscriptionId) {
          const subscription = await stripe.subscriptions.retrieve(invoiceSubscriptionId);
          const subs = await prisma.subscription.findMany({ where: { stripe_subscription_id: invoiceSubscriptionId } });

          if (subs.length > 0) {
            const sub = subs[0];
            await prisma.subscription.update({
              where: { id: sub.id },
              data: {
                status: 'active',
                next_billing_date: new Date(subscription.current_period_end * 1000),
                current_period_end: new Date(subscription.current_period_end * 1000),
                reminder_before_sent: false,
                reminder_after_sent: false,
              },
            });

            await prisma.paymentHistory.create({
              data: {
                user_email: sub.user_email,
                subscription_id: invoiceSubscriptionId,
                amount: invoice.amount_paid / 100,
                currency: invoice.currency?.toUpperCase(),
                status: 'succeeded',
                payment_date: new Date(invoice.created * 1000),
                stripe_payment_id: invoice.payment_intent,
              },
            });

            const user = await prisma.user.findUnique({ where: { email: sub.user_email } });
            if (user && user.subscription_source !== 'admin') {
              await prisma.user.update({
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
          } else {
            console.log(`[Webhook] No subscription record found in DB for ${invoiceSubscriptionId}`);
          }
        } else {
          console.log(`[Webhook] invoice.payment_succeeded — no customerId and no subscriptionId, nothing to process`);
        }
        break;
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object as any;
        const customerId = invoice.metadata?.customer_id;
        // Support both old API (invoice.subscription) and new basil API (invoice.parent.subscription_details.subscription)
        const invoiceSubId: string | undefined = invoice.subscription || invoice.parent?.subscription_details?.subscription;
        console.log(`[Webhook] invoice.payment_failed — invoiceId: ${invoice.id}, customerId: ${customerId}, subscriptionId: ${invoiceSubId}`);

        if (customerId) {
          const customerOwnerEmail = invoice.metadata?.customer_owner_email;
          if (customerOwnerEmail) {
            const ownerUser = await prisma.user.findUnique({ where: { email: customerOwnerEmail } });
            if (ownerUser) {
              const customer = await prisma.customer.findFirst({
                where: { id: customerId, created_by: ownerUser.id, is_deleted: false },
              });
              if (customer) {
                await prisma.customer.update({
                  where: { id: customer.id },
                  data: { payment_status: 'Overdue', status: 'inactive', active: false, inactive_reason: 'payment_failed' },
                });
              }
            }
          }
          break;
        }

        if (invoiceSubId) {
          const subs = await prisma.subscription.findMany({ where: { stripe_subscription_id: invoiceSubId } });
          if (subs.length > 0) {
            const sub = subs[0];
            await prisma.subscription.update({ where: { id: sub.id }, data: { status: 'past_due' } });
            await prisma.paymentHistory.create({
              data: {
                user_email: sub.user_email,
                subscription_id: invoiceSubId,
                amount: invoice.amount_due / 100,
                currency: invoice.currency?.toUpperCase(),
                status: 'failed',
                payment_date: new Date(invoice.created * 1000),
                stripe_payment_id: invoice.payment_intent,
                error_message: invoice.last_payment_error?.message || 'Payment failed',
              },
            });

            const user = await prisma.user.findUnique({ where: { email: sub.user_email } });
            if (user) {
              await prisma.user.update({
                where: { id: user.id },
                data: { subscription_status: 'past_due', is_paid: false, last_payment_status: 'failed' },
              });
            }

            await sendEmail({
              to: sub.user_email,
              subject: '⚠️ Payment Failed - TiffinHub Manager',
              body: `Your subscription payment failed. Please update your payment method in the Billing page.`,
            });
          }
        }
        break;
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object as any;
        console.log(`[Webhook] customer.subscription.updated — subscriptionId: ${subscription.id}, status: ${subscription.status}`);
        const subs = await prisma.subscription.findMany({ where: { stripe_subscription_id: subscription.id } });

        if (subs.length > 0) {
          const sub = subs[0];
          await prisma.subscription.update({
            where: { id: sub.id },
            data: {
              status: subscription.status,
              next_billing_date: new Date(subscription.current_period_end * 1000),
              current_period_end: new Date(subscription.current_period_end * 1000),
            },
          });

          const user = await prisma.user.findUnique({ where: { email: sub.user_email } });
          if (user && user.subscription_source !== 'admin') {
            await prisma.user.update({
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
        const subscription = event.data.object as any;
        console.log(`[Webhook] customer.subscription.deleted — subscriptionId: ${subscription.id}`);
        const subs = await prisma.subscription.findMany({ where: { stripe_subscription_id: subscription.id } });

        if (subs.length > 0) {
          const sub = subs[0];
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'cancelled', cancelled_at: new Date() },
          });

          const user = await prisma.user.findUnique({ where: { email: sub.user_email } });
          if (user && user.subscription_status !== 'cancelled') {
            await prisma.user.update({
              where: { id: user.id },
              data: { subscription_status: 'cancelled', is_paid: false, plan_type: 'none', last_payment_status: 'cancelled' },
            });
          }

          await sendEmail({
            to: sub.user_email,
            subject: 'Subscription Cancelled - TiffinHub Manager',
            body: `Your subscription has been cancelled. You can reactivate from the Billing page.`,
          });
        }
        break;
      }
    }

    console.log(`[Webhook] Successfully processed event: ${event.type}`);
    res.json({ received: true });
  } catch (error: any) {
    console.error(`[Webhook] Error processing event ${event?.type}:`, error);
    res.status(500).json({ error: error.message });
  }
});

export default router;
