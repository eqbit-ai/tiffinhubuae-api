import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import rateLimit from 'express-rate-limit';
import authRoutes from './routes/auth';
import entityRoutes from './routes/entities';
import functionRoutes from './routes/functions';
import integrationRoutes from './routes/integrations';
import webhookRoutes from './routes/webhooks';
import portalRoutes from './routes/portal';
import driverRoutes from './routes/driver';
import { startCronJobs } from './cron';

// --- JWT_SECRET startup validation ---
const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret || jwtSecret === 'change-me-in-production') {
  console.error('[FATAL] JWT_SECRET is missing or set to the insecure default. Set a strong JWT_SECRET env var.');
  process.exit(1);
}

const app = express();
app.set('trust proxy', 1); // Trust first proxy (Railway, Vercel, etc.)
const PORT = process.env.PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

// --- Rate limiters ---
const generalLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, please try again later.' },
});

// Stripe webhooks need raw body
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(helmet());
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

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
  res.setHeader('Access-Control-Allow-Origin', FRONTEND_URL);
  next();
}, express.static(path.join(__dirname, '../uploads')));

// Health check (before auth-gated routes)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/functions', functionRoutes);
app.use('/api/integrations', integrationRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/portal', portalRoutes);
app.use('/api/driver', driverRoutes);
// Entity routes last (wildcard /:entity)
app.use('/api', entityRoutes);

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
  } else {
    console.log(`[WhatsApp] Twilio configured — from: ${process.env.TWILIO_WHATSAPP_FROM}`);
  }
  startCronJobs();
});

export default app;
