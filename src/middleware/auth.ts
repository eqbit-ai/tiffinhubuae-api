import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../lib/prisma';

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';

export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    full_name: string | null;
    is_super_admin: boolean;
    [key: string]: any;
  };
}

export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

export async function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };
    const user = await prisma.user.findUnique({ where: { id: decoded.userId } });
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }
    req.user = user as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export function superAdminOnly(req: AuthRequest, res: Response, next: NextFunction) {
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
  const isSuperAdmin = req.user?.email === DEFAULT_SUPER_ADMIN || req.user?.is_super_admin === true;
  if (!isSuperAdmin) {
    return res.status(403).json({ error: 'Forbidden: Super Admin only' });
  }
  next();
}

export function checkPremiumAccess(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user!;
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
  const isSuperAdmin = user.email === DEFAULT_SUPER_ADMIN || user.is_super_admin === true;
  const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
  const hasPremiumAccess = isSuperAdmin || hasSpecialAccess || user.plan_type === 'premium';

  if (!hasPremiumAccess) {
    return res.status(403).json({
      error: 'This feature is available in the Premium plan',
      current_plan: user.plan_type || 'none',
      upgrade_required: true,
    });
  }
  next();
}
