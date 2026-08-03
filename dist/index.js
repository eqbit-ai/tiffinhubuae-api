"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const helmet_1 = __importDefault(require("helmet"));
const path_1 = __importDefault(require("path"));
const express_rate_limit_1 = __importDefault(require("express-rate-limit"));
const auth_1 = __importDefault(require("./routes/auth"));
const entities_1 = __importDefault(require("./routes/entities"));
const functions_1 = __importDefault(require("./routes/functions"));
const integrations_1 = __importDefault(require("./routes/integrations"));
const webhooks_1 = __importDefault(require("./routes/webhooks"));
const portal_1 = __importDefault(require("./routes/portal"));
const driver_1 = __importDefault(require("./routes/driver"));
const notifications_1 = __importDefault(require("./routes/notifications"));
const cron_1 = require("./cron");
const prisma_1 = require("./lib/prisma");
// --- JWT_SECRET startup validation ---
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me-in-production') {
    console.error('[FATAL] JWT_SECRET is missing or set to the insecure default. Set a strong JWT_SECRET env var.');
    process.exit(1);
}
const app = (0, express_1.default)();
app.set('trust proxy', 1); // Trust first proxy (Railway, Vercel, etc.)
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
// --- Rate limiters ---
const generalLimiter = (0, express_rate_limit_1.default)({
    windowMs: 60 * 1000, // 1 minute
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests, please try again later.' },
});
const authLimiter = (0, express_rate_limit_1.default)({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many authentication attempts, please try again later.' },
});
// Stripe webhooks need raw body
app.use('/api/webhooks/stripe', express_1.default.raw({ type: 'application/json' }));
app.use((0, helmet_1.default)());
// Allow web frontend + mobile app origins
const MOBILE_APP_ORIGINS = (process.env.MOBILE_APP_ORIGINS || '').split(',').filter(Boolean);
app.use((0, cors_1.default)({
    origin: (origin, callback) => {
        // Allow requests with no origin (mobile apps, curl, server-to-server)
        if (!origin)
            return callback(null, true);
        const allowedOrigins = [FRONTEND_URL, ...MOBILE_APP_ORIGINS];
        if (allowedOrigins.includes(origin) || origin.startsWith('exp://') || origin.startsWith('tiffinhub://')) {
            return callback(null, true);
        }
        callback(null, false);
    },
    credentials: true,
}));
app.use(express_1.default.json({ limit: '10mb' }));
// Apply general rate limiter to all routes
app.use(generalLimiter);
// Apply strict rate limiter to auth endpoints
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/reset-password', authLimiter);
app.use('/api/driver/auth', authLimiter);
app.use('/api/portal/send-otp', authLimiter);
// Static file serving for uploads (with cross-origin headers for frontend)
app.use('/uploads', (_req, res, next) => {
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    res.setHeader('Access-Control-Allow-Origin', '*');
    next();
}, express_1.default.static(path_1.default.join(__dirname, '../uploads')));
// Track server start time for uptime calculation
const serverStartTime = Date.now();
// Health check with real metrics (before auth-gated routes)
app.get('/api/health', async (_req, res) => {
    const mem = process.memoryUsage();
    let dbStatus = 'ok';
    try {
        await prisma_1.prisma.$queryRaw `SELECT 1`;
    }
    catch {
        dbStatus = 'down';
    }
    res.json({
        status: dbStatus === 'ok' ? 'ok' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
        database: dbStatus,
        memory: {
            rss_mb: Math.round(mem.rss / 1024 / 1024),
            heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
            heap_total_mb: Math.round(mem.heapTotal / 1024 / 1024),
        },
        node_version: process.version,
    });
});
// Routes
app.use('/api/auth', auth_1.default);
app.use('/api/functions', functions_1.default);
app.use('/api/integrations', integrations_1.default);
app.use('/api/webhooks', webhooks_1.default);
app.use('/api/portal', portal_1.default);
app.use('/api/driver', driver_1.default);
app.use('/api/notifications', notifications_1.default);
// Entity routes last (wildcard /:entity)
app.use('/api', entities_1.default);
// Global error handler — logs to SystemLog table
app.use((err, req, res, _next) => {
    const status = err.status || 500;
    const message = err.message || 'Internal server error';
    console.error(`[ERROR] ${req.method} ${req.path}:`, message);
    // Log server errors (5xx) to database asynchronously
    if (status >= 500) {
        prisma_1.prisma.systemLog.create({
            data: {
                log_type: 'error',
                severity: 'high',
                source: `${req.method} ${req.path}`,
                message: message,
                error_details: err.stack?.slice(0, 2000) || null,
                affected_user: req.user?.email || null,
            },
        }).catch((logErr) => console.error('[SystemLog] Failed to save:', logErr.message));
    }
    res.status(status).json({ error: message });
});
app.listen(PORT, () => {
    console.log(`TiffinHub API running on port ${PORT}`);
    if (!process.env.STRIPE_WEBHOOK_SECRET) {
        console.warn('[WARNING] STRIPE_WEBHOOK_SECRET is not set — Stripe webhooks will fail signature verification');
    }
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_WHATSAPP_FROM) {
        console.warn('[WARNING] Twilio WhatsApp not fully configured — missing:', [
            !process.env.TWILIO_ACCOUNT_SID && 'TWILIO_ACCOUNT_SID',
            !process.env.TWILIO_AUTH_TOKEN && 'TWILIO_AUTH_TOKEN',
            !process.env.TWILIO_WHATSAPP_FROM && 'TWILIO_WHATSAPP_FROM',
        ].filter(Boolean).join(', '));
    }
    else {
        console.log(`[WhatsApp] Twilio configured — from: ${process.env.TWILIO_WHATSAPP_FROM}`);
    }
    (0, cron_1.startCronJobs)();
});
exports.default = app;
//# sourceMappingURL=index.js.map