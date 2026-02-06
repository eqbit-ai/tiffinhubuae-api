"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.generateToken = generateToken;
exports.generateCustomerToken = generateCustomerToken;
exports.authMiddleware = authMiddleware;
exports.superAdminOnly = superAdminOnly;
exports.checkPremiumAccess = checkPremiumAccess;
exports.customerAuthMiddleware = customerAuthMiddleware;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const prisma_1 = require("../lib/prisma");
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production';
function generateToken(userId) {
    return jsonwebtoken_1.default.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}
function generateCustomerToken(customerId, merchantId) {
    return jsonwebtoken_1.default.sign({ customerId, merchantId, type: 'customer' }, JWT_SECRET, { expiresIn: '30d' });
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
        req.user = user;
        next();
    }
    catch {
        return res.status(401).json({ error: 'Invalid token' });
    }
}
function superAdminOnly(req, res, next) {
    const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@eqbit.ai';
    const isSuperAdmin = req.user?.email === DEFAULT_SUPER_ADMIN || req.user?.is_super_admin === true;
    if (!isSuperAdmin) {
        return res.status(403).json({ error: 'Forbidden: Super Admin only' });
    }
    next();
}
function checkPremiumAccess(req, res, next) {
    const user = req.user;
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
//# sourceMappingURL=auth.js.map