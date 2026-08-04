"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.checkPremiumAccess = void 0;
exports.generateToken = generateToken;
exports.generateCustomerToken = generateCustomerToken;
exports.generateDriverToken = generateDriverToken;
exports.authMiddleware = authMiddleware;
exports.hasProductAccess = hasProductAccess;
exports.superAdminOnly = superAdminOnly;
exports.blockIfImpersonating = blockIfImpersonating;
exports.checkActiveSubscription = checkActiveSubscription;
exports.customerAuthMiddleware = customerAuthMiddleware;
exports.driverAuthMiddleware = driverAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../lib/prisma");
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
if (!process.env.JWT_SECRET) {
    console.error('⚠️  CRITICAL: JWT_SECRET environment variable is not set! Using insecure default.');
}
function generateToken(userId, impersonatedBy) {
    const payload = { userId };
    if (impersonatedBy)
        payload.impersonatedBy = impersonatedBy;
    return jsonwebtoken_1.default.sign(payload, JWT_SECRET, { expiresIn: impersonatedBy ? '4h' : '30d' });
}
function generateCustomerToken(customerId, merchantId) {
    return jsonwebtoken_1.default.sign({ customerId, merchantId, type: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
}
function generateDriverToken(driverId, merchantId) {
    return jsonwebtoken_1.default.sign({ driverId, merchantId, type: 'driver' }, JWT_SECRET, { expiresIn: '12h' });
}
async function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        const user = await prisma_1.prisma.user.findUnique({ where: { id: decoded.userId } });
        if (!user) {
            return res.status(401).json({ error: 'User not found' });
        }
        user.impersonatedBy = decoded.impersonatedBy || null;
        req.user = user;
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
function isUserSuperAdmin(user) {
    const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@tiffinhub.me';
    return user?.email === DEFAULT_SUPER_ADMIN || user?.is_super_admin === true;
}
/**
 * Whether this user may use the product at all. There is one plan, so this is
 * the only entitlement question the app ever needs to ask — the mirror of the
 * frontend's utils/accessControl.hasPremiumAccess.
 */
function hasProductAccess(user) {
    if (!user)
        return false;
    if (isUserSuperAdmin(user))
        return true;
    if (user.special_access_type && user.special_access_type !== 'none')
        return true;
    const status = user.subscription_status;
    return status !== 'expired' && status !== 'cancelled' && !!status;
}
function superAdminOnly(req, res, next) {
    if (!isUserSuperAdmin(req.user)) {
        return res.status(403).json({ error: 'Forbidden: Super Admin only' });
    }
    next();
}
function blockIfImpersonating(req, res, next) {
    if (req.user?.impersonatedBy) {
        return res.status(403).json({ error: 'This action is not allowed while impersonating a user' });
    }
    next();
}
function checkActiveSubscription(req, res, next) {
    const user = req.user;
    // Super admins and special_access users bypass subscription check
    if (isUserSuperAdmin(user))
        return next();
    const hasSpecialAccess = user.special_access_type && user.special_access_type !== 'none';
    if (hasSpecialAccess)
        return next();
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
/**
 * There is one plan, so "premium" is no longer a tier — every feature ships to
 * every subscriber. Kept under its old name because ~10 routes reference it;
 * it is now exactly an active-subscription check.
 */
exports.checkPremiumAccess = checkActiveSubscription;
async function customerAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        if (decoded.type !== 'customer') {
            return res.status(401).json({ error: 'Invalid token type' });
        }
        const customer = await prisma_1.prisma.customer.findFirst({
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
        };
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
async function driverAuthMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const token = authHeader.slice(7);
    try {
        const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
        if (decoded.type !== 'driver') {
            return res.status(401).json({ error: 'Invalid token type' });
        }
        const driver = await prisma_1.prisma.driver.findFirst({
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
        };
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
//# sourceMappingURL=auth.js.map