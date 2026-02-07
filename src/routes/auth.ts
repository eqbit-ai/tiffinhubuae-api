import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { generateToken, authMiddleware, superAdminOnly, AuthRequest } from '../middleware/auth';
import { sendEmail } from '../services/email';

const router = Router();

// POST /api/auth/register
router.post('/register', async (req, res) => {
  try {
    const { email, password, full_name } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });

    // Handle re-signup after account deletion
    if (existing && existing.subscription_status === 'deleted') {
      // Previous user deleted their account — allow re-signup but NO free trial
      const password_hash = await bcrypt.hash(password, 12);
      const user = await prisma.user.update({
        where: { email },
        data: {
          password_hash,
          full_name: full_name || null,
          subscription_status: 'expired',
          plan_type: null,
          subscription_source: null,
          trial_ends_at: null,
          subscription_ends_at: null,
        },
      });
      const token = generateToken(user.id);
      const { password_hash: _ph, ...safeUser } = user;
      return res.status(201).json({ token, user: safeUser });
    }

    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    const user = await prisma.user.create({
      data: {
        email,
        password_hash,
        full_name: full_name || null,
        subscription_status: 'trial',
        plan_type: 'trial',
        subscription_source: 'trial',
        trial_ends_at: trialEndsAt,
      },
    });

    const token = generateToken(user.id);
    const { password_hash: _, ...safeUser } = user;

    // Send welcome email (non-blocking)
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
    sendEmail({
      to: email,
      subject: 'Welcome to TiffinHub Manager!',
      body: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 30px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 28px;">Welcome to TiffinHub!</h1>
          </div>
          <div style="background: #ffffff; padding: 30px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="font-size: 16px; color: #334155;">Hi ${full_name || 'there'},</p>
            <p style="font-size: 15px; color: #475569; line-height: 1.6;">
              Thank you for signing up! Your <strong>7-day free trial</strong> is now active.
              You have full access to all features — start adding customers, managing menus, and tracking deliveries right away.
            </p>
            <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 16px; margin: 20px 0;">
              <p style="margin: 0 0 8px; font-weight: bold; color: #166534;">Your trial includes:</p>
              <ul style="margin: 0; padding-left: 20px; color: #15803d; font-size: 14px; line-height: 1.8;">
                <li>Unlimited customers & orders</li>
                <li>Delivery management with driver tracking</li>
                <li>WhatsApp notifications & payment reminders</li>
                <li>Kitchen display, labels, analytics & more</li>
              </ul>
            </div>
            <p style="font-size: 15px; color: #475569;">
              Trial ends on: <strong>${trialEndsAt.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}</strong>
            </p>
            <div style="text-align: center; margin: 24px 0;">
              <a href="${frontendUrl}" style="background: #6366f1; color: white; padding: 12px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
                Open Dashboard
              </a>
            </div>
            <p style="font-size: 13px; color: #94a3b8; text-align: center; margin-top: 24px;">
              Need help? Reply to this email or visit your Settings page.
            </p>
          </div>
        </div>
      `,
    }).catch(err => console.error('[Welcome Email] Failed:', err));

    res.status(201).json({ token, user: safeUser });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = generateToken(user.id);
    const { password_hash: _, ...safeUser } = user;
    res.json({ token, user: safeUser });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/auth/me
router.get('/me', authMiddleware, async (req: AuthRequest, res) => {
  const { password_hash: _, ...safeUser } = req.user as any;
  if (safeUser.created_at) safeUser.created_date = safeUser.created_at;
  if (safeUser.updated_at) safeUser.updated_date = safeUser.updated_at;
  safeUser.whatsapp_limit = Math.max(safeUser.whatsapp_limit || 400, 400);
  res.json(safeUser);
});

// PUT /api/auth/me
router.put('/me', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const allowedFields = [
      'full_name', 'phone', 'business_name', 'logo_url',
      'whatsapp_notifications_enabled', 'whatsapp_number',
    ];
    const data: any = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) data[field] = req.body[field];
    }

    const updated = await prisma.user.update({ where: { id: userId }, data });
    const { password_hash: _, ...safeUser } = updated;
    res.json(safeUser);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/impersonate — super admin generates a token for target user
router.post('/impersonate', authMiddleware, superAdminOnly, async (req: AuthRequest, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });

    const targetUser = await prisma.user.findUnique({ where: { email } });
    if (!targetUser) return res.status(404).json({ error: 'User not found' });

    const token = generateToken(targetUser.id);
    const { password_hash: _, ...safeUser } = targetUser;
    res.json({ token, user: safeUser });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/auth/delete-account
router.delete('/delete-account', authMiddleware, async (req: AuthRequest, res) => {
  try {
    const userId = req.user!.id;
    const userEmail = req.user!.email;

    // Record that this email previously had an account (for trial restriction)
    // We store it before deleting so re-signups skip trial
    await prisma.user.update({
      where: { id: userId },
      data: {
        // Mark as deleted before purging — flag the email for future signups
      },
    });

    // Delete all user-owned data across all entities
    await Promise.all([
      prisma.customer.deleteMany({ where: { created_by: userId } }),
      prisma.order.deleteMany({ where: { created_by: userId } }),
      prisma.menuItem.deleteMany({ where: { created_by: userId } }),
      prisma.tiffinSkip.deleteMany({ where: { created_by: userId } }),
      prisma.activityLog.deleteMany({ where: { created_by: userId } }),
      prisma.ingredient.deleteMany({ where: { created_by: userId } }),
      prisma.recipe.deleteMany({ where: { created_by: userId } }),
      prisma.supplier.deleteMany({ where: { created_by: userId } }),
      prisma.purchase.deleteMany({ where: { created_by: userId } }),
      prisma.wastage.deleteMany({ where: { created_by: userId } }),
      prisma.paymentLink.deleteMany({ where: { created_by: userId } }),
      prisma.notification.deleteMany({ where: { user_email: userEmail } }),
      prisma.supportTicket.deleteMany({ where: { user_email: userEmail } }),
      prisma.subscription.deleteMany({ where: { user_email: userEmail } }),
      prisma.paymentHistory.deleteMany({ where: { user_email: userEmail } }),
    ]);

    // Store a deleted-account record so re-signups don't get a free trial
    // We use a simple approach: create a record in a lightweight way
    // by keeping a tombstone user row with a special flag
    await prisma.user.update({
      where: { id: userId },
      data: {
        password_hash: '__DELETED__',
        full_name: '__DELETED__',
        subscription_status: 'deleted',
        plan_type: null,
        stripe_customer_id: null,
        stripe_subscription_id: null,
        subscription_ends_at: null,
        trial_ends_at: null,
      },
    });

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/forgot-password
router.post('/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (user && user.subscription_status !== 'deleted') {
      const token = crypto.randomBytes(32).toString('hex');
      const expires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { reset_token: token, reset_token_expires: expires },
      });

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const resetLink = `${frontendUrl}/reset-password?token=${token}`;

      sendEmail({
        to: email,
        subject: 'Reset your TiffinHub password',
        body: `
          <h2>Password Reset</h2>
          <p>You requested a password reset. Click the link below to set a new password:</p>
          <p><a href="${resetLink}">${resetLink}</a></p>
          <p>This link expires in 1 hour.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      }).catch(err => console.error('[Email] Forgot password send failed:', err));
    }

    // Always return success to avoid revealing whether the email exists
    res.json({ message: 'If an account with that email exists, a reset link has been sent.' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/auth/reset-password
router.post('/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    const user = await prisma.user.findFirst({
      where: {
        reset_token: token,
        reset_token_expires: { gt: new Date() },
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const password_hash = await bcrypt.hash(password, 12);
    await prisma.user.update({
      where: { id: user.id },
      data: {
        password_hash,
        reset_token: null,
        reset_token_expires: null,
      },
    });

    // Send confirmation email
    sendEmail({
      to: user.email,
      subject: 'Your TiffinHub password has been reset',
      body: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: linear-gradient(135deg, #6366f1, #8b5cf6); padding: 24px; border-radius: 12px 12px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">Password Reset Successful</h1>
          </div>
          <div style="background: #fff; padding: 24px; border: 1px solid #e2e8f0; border-top: none; border-radius: 0 0 12px 12px;">
            <p style="font-size: 15px; color: #334155;">Hi ${user.full_name || 'there'},</p>
            <p style="font-size: 15px; color: #475569;">Your password has been successfully reset. You can now log in with your new password.</p>
            <p style="font-size: 13px; color: #94a3b8; margin-top: 20px;">If you did not make this change, please contact support immediately.</p>
          </div>
        </div>
      `,
    }).catch(err => console.error('[Email] Reset confirmation failed:', err));

    res.json({ message: 'Password has been reset successfully' });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
