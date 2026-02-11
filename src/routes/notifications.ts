import { Router, Response } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, AuthRequest, customerAuthMiddleware, CustomerAuthRequest } from '../middleware/auth';

const router = Router();

// ─── Register device token (merchant auth) ───────────────────
router.post('/register-device', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { expo_push_token, platform } = req.body;

    if (!expo_push_token || !expo_push_token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }

    // Upsert: if token exists, update it; otherwise create
    const token = await prisma.deviceToken.upsert({
      where: { expo_push_token },
      update: {
        user_id: req.user!.id,
        user_email: req.user!.email,
        platform: platform || 'ios',
        is_active: true,
        customer_id: null, // Clear customer association if re-registering as merchant
      },
      create: {
        expo_push_token,
        user_id: req.user!.id,
        user_email: req.user!.email,
        platform: platform || 'ios',
      },
    });

    res.json({ success: true, id: token.id });
  } catch (error: any) {
    console.error('[Notifications] Register device failed:', error.message);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

// ─── Unregister device token (merchant auth) ─────────────────
router.delete('/unregister-device', authMiddleware, async (req: AuthRequest, res: Response) => {
  try {
    const { expo_push_token } = req.body;

    if (!expo_push_token) {
      return res.status(400).json({ error: 'Missing expo_push_token' });
    }

    await prisma.deviceToken.updateMany({
      where: { expo_push_token, user_id: req.user!.id },
      data: { is_active: false },
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error('[Notifications] Unregister device failed:', error.message);
    res.status(500).json({ error: 'Failed to unregister device' });
  }
});

// ─── Register device token (customer portal auth) ────────────
router.post('/register-device/customer', customerAuthMiddleware, async (req: CustomerAuthRequest, res: Response) => {
  try {
    const { expo_push_token, platform } = req.body;

    if (!expo_push_token || !expo_push_token.startsWith('ExponentPushToken[')) {
      return res.status(400).json({ error: 'Invalid Expo push token' });
    }

    const token = await prisma.deviceToken.upsert({
      where: { expo_push_token },
      update: {
        customer_id: req.customer!.id,
        platform: platform || 'ios',
        is_active: true,
        user_id: null,
        user_email: null,
      },
      create: {
        expo_push_token,
        customer_id: req.customer!.id,
        platform: platform || 'ios',
      },
    });

    res.json({ success: true, id: token.id });
  } catch (error: any) {
    console.error('[Notifications] Customer register device failed:', error.message);
    res.status(500).json({ error: 'Failed to register device' });
  }
});

export default router;
