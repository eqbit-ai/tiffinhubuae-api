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

export interface CustomerAuthRequest extends Request {
  customer?: {
    id: string;
    full_name: string;
    phone_number: string | null;
    merchant_id: string;
    [key: string]: any;
  };
}

export interface DriverAuthRequest extends Request {
  driver?: {
    id: string;
    name: string;
    phone: string | null;
    merchant_id: string;
    [key: string]: any;
  };
}

export function generateToken(userId: string): string {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

export function generateCustomerToken(customerId: string, merchantId: string): string {
  return jwt.sign({ customerId, merchantId, type: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
}

export function generateDriverToken(driverId: string, merchantId: string): string {
  return jwt.sign({ driverId, merchantId, type: 'driver' }, JWT_SECRET, { expiresIn: '12h' });
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

function isUserSuperAdmin(user: AuthRequest['user']): boolean {
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@tiffinhub.me';
  return user?.email === DEFAULT_SUPER_ADMIN || user?.is_super_admin === true;
}

export function superAdminOnly(req: AuthRequest, res: Response, next: NextFunction) {
  if (!isUserSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden: Super Admin only' });
  }
  next();
}

export function checkActiveSubscription(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user!;

  // Super admins and special_access users bypass subscription check
  if (isUserSuperAdmin(user)) return next();
  const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
  if (hasSpecialAccess) return next();

  const status = user.subscription_status;
  if (status === 'expired' || status === 'cancelled') {
    return res.status(403).json({
      error: 'Your subscription has expired. Please renew to continue.',
      subscription_status: status,
      renewal_required: true,
    });
  }

  next();
}

export function checkPremiumAccess(req: AuthRequest, res: Response, next: NextFunction) {
  const user = req.user!;

  if (isUserSuperAdmin(user)) return next();
  const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
  if (hasSpecialAccess) return next();

  // Check subscription is active first
  const status = user.subscription_status;
  if (status === 'expired' || status === 'cancelled') {
    return res.status(403).json({
      error: 'Your subscription has expired. Please renew to continue.',
      subscription_status: status,
      renewal_required: true,
    });
  }

  if (user.plan_type !== 'premium') {
    return res.status(403).json({
      error: 'This feature is available in the Premium plan',
      current_plan: user.plan_type || 'none',
      upgrade_required: true,
    });
  }
  next();
}

export async function customerAuthMiddleware(req: CustomerAuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { customerId: string; merchantId: string; type: string };

    if (decoded.type !== 'customer') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const customer = await prisma.customer.findFirst({
      where: {
        id: decoded.customerId,
        created_by: decoded.merchantId,
        is_deleted: false,
      },
    });

    if (!customer) {
      return res.status(401).json({ error: 'Customer not found' });
    }

    req.customer = {
      ...customer,
      merchant_id: decoded.merchantId,
    } as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export async function driverAuthMiddleware(req: DriverAuthRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7);
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as { driverId: string; merchantId: string; type: string };

    if (decoded.type !== 'driver') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const driver = await prisma.driver.findFirst({
      where: {
        id: decoded.driverId,
        created_by: decoded.merchantId,
        is_active: true,
      },
    });

    if (!driver) {
      return res.status(401).json({ error: 'Driver not found' });
    }

    req.driver = {
      ...driver,
      merchant_id: decoded.merchantId,
    } as any;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
