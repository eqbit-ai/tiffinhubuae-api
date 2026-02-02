import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import path from 'path';
import authRoutes from './routes/auth';
import entityRoutes from './routes/entities';
import functionRoutes from './routes/functions';
import integrationRoutes from './routes/integrations';
import webhookRoutes from './routes/webhooks';
import portalRoutes from './routes/portal';
import { startCronJobs } from './cron';

const app = express();
const PORT = process.env.PORT || 3001;

// Stripe webhooks need raw body
app.use('/api/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

// Static file serving for uploads (with cross-origin headers for frontend)
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.setHeader('Access-Control-Allow-Origin', '*');
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
// Entity routes last (wildcard /:entity)
app.use('/api', entityRoutes);

app.listen(PORT, () => {
  console.log(`TiffinHub API running on port ${PORT}`);
  startCronJobs();
});

export default app;
