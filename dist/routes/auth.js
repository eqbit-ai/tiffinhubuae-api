"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const prisma_1 = require("../lib/prisma");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
// POST /api/auth/register
router.post('/register', async (req, res) => {
    try {
        const { email, password, full_name } = req.body;
        if (!email || !password) {
            return res.status(400).json({ error: 'Email and password required' });
        }
        const existing = await prisma_1.prisma.user.findUnique({ where: { email } });
        // Handle re-signup after account deletion
        if (existing && existing.subscription_status === 'deleted') {
            // Previous user deleted their account — allow re-signup but NO free trial
            const password_hash = await bcryptjs_1.default.hash(password, 12);
            const user = await prisma_1.prisma.user.update({
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
            const token = (0, auth_1.generateToken)(user.id);
            const { password_hash: _ph, ...safeUser } = user;
            return res.status(201).json({ token, user: safeUser });
        }
        if (existing) {
            return res.status(409).json({ error: 'Email already registered' });
        }
        const password_hash = await bcryptjs_1.default.hash(password, 12);
        const trialEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        const user = await prisma_1.prisma.user.create({
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
        const token = (0, auth_1.generateToken)(user.id);
        const { password_hash: _, ...safeUser } = user;
        res.status(201).json({ token, user: safeUser });
    }
    catch (error) {
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
        const user = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!user) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const valid = await bcryptjs_1.default.compare(password, user.password_hash);
        if (!valid) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const token = (0, auth_1.generateToken)(user.id);
        const { password_hash: _, ...safeUser } = user;
        res.json({ token, user: safeUser });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// GET /api/auth/me
router.get('/me', auth_1.authMiddleware, async (req, res) => {
    const { password_hash: _, ...safeUser } = req.user;
    if (safeUser.created_at)
        safeUser.created_date = safeUser.created_at;
    if (safeUser.updated_at)
        safeUser.updated_date = safeUser.updated_at;
    res.json(safeUser);
});
// PUT /api/auth/me
router.put('/me', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const allowedFields = [
            'full_name', 'phone', 'business_name', 'logo_url',
            'whatsapp_notifications_enabled', 'whatsapp_number',
        ];
        const data = {};
        for (const field of allowedFields) {
            if (req.body[field] !== undefined)
                data[field] = req.body[field];
        }
        const updated = await prisma_1.prisma.user.update({ where: { id: userId }, data });
        const { password_hash: _, ...safeUser } = updated;
        res.json(safeUser);
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// POST /api/auth/impersonate — super admin generates a token for target user
router.post('/impersonate', auth_1.authMiddleware, auth_1.superAdminOnly, async (req, res) => {
    try {
        const { email } = req.body;
        if (!email)
            return res.status(400).json({ error: 'Email required' });
        const targetUser = await prisma_1.prisma.user.findUnique({ where: { email } });
        if (!targetUser)
            return res.status(404).json({ error: 'User not found' });
        const token = (0, auth_1.generateToken)(targetUser.id);
        const { password_hash: _, ...safeUser } = targetUser;
        res.json({ token, user: safeUser });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
// DELETE /api/auth/delete-account
router.delete('/delete-account', auth_1.authMiddleware, async (req, res) => {
    try {
        const userId = req.user.id;
        const userEmail = req.user.email;
        // Record that this email previously had an account (for trial restriction)
        // We store it before deleting so re-signups skip trial
        await prisma_1.prisma.user.update({
            where: { id: userId },
            data: {
            // Mark as deleted before purging — flag the email for future signups
            },
        });
        // Delete all user-owned data across all entities
        await Promise.all([
            prisma_1.prisma.customer.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.order.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.menuItem.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.tiffinSkip.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.activityLog.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.ingredient.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.recipe.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.supplier.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.purchase.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.wastage.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.paymentLink.deleteMany({ where: { created_by: userId } }),
            prisma_1.prisma.notification.deleteMany({ where: { user_email: userEmail } }),
            prisma_1.prisma.supportTicket.deleteMany({ where: { user_email: userEmail } }),
            prisma_1.prisma.subscription.deleteMany({ where: { user_email: userEmail } }),
            prisma_1.prisma.paymentHistory.deleteMany({ where: { user_email: userEmail } }),
        ]);
        // Store a deleted-account record so re-signups don't get a free trial
        // We use a simple approach: create a record in a lightweight way
        // by keeping a tombstone user row with a special flag
        await prisma_1.prisma.user.update({
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
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
});
exports.default = router;
//# sourceMappingURL=auth.js.map