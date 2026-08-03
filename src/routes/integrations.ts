import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { sendEmail } from '../services/email';

const router = Router();

// Prisma validation errors name models, columns and argument types, and the
// entity router lets a caller steer them via ?sortBy= and the where filter —
// which turns a 500 into a free schema dump. Log the detail, return a generic
// message.
function safeError(error: any): string {
  console.error('[error]', error?.message || error);
  return 'Something went wrong. Please try again.';
}
router.use(authMiddleware);

// File upload config
const uploadsDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const ALLOWED_MIME_TYPES = new Set([
  'image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
]);

const ALLOWED_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.pdf']);

const fileFilter: multer.Options['fileFilter'] = (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ALLOWED_MIME_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(ext)) {
    cb(null, true);
  } else {
    cb(new Error('Only image files (jpg, png, gif, webp) and PDFs are allowed'));
  }
};

const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter });

// POST /api/integrations/send-email
//
// The recipient must belong to the caller. Without this check any merchant —
// and signup is free and instant — could send arbitrary HTML from the
// platform's verified sender to any address: phishing other merchants from a
// domain that passes SPF/DKIM, and a fast route to getting the domain
// blacklisted, which would silently kill payment reminders for everyone.
// /functions/send-customer-email already scoped its recipient this way.
router.post('/send-email', async (req: AuthRequest, res) => {
  try {
    const user = req.user!;
    const { to, subject, body } = req.body;
    if (!to || !subject || !body) {
      return res.status(400).json({ error: 'to, subject, body required' });
    }

    const recipient = String(to).trim().toLowerCase();
    const isOwnAddress = recipient === user.email?.toLowerCase();
    const ownsRecipient = isOwnAddress
      ? true
      : !!(await prisma.customer.findFirst({
          where: { email: { equals: recipient, mode: 'insensitive' }, created_by: user.id, is_deleted: false },
          select: { id: true },
        }));

    if (!ownsRecipient) {
      return res.status(403).json({ error: 'Recipient must be one of your own customers' });
    }

    const result = await sendEmail({ to, subject, body });
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: safeError(error) });
  }
});

// POST /api/integrations/upload
router.post('/upload', upload.single('file'), async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const fileUrl = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
    res.json({ file_url: fileUrl, filename: req.file.filename });
  } catch (error: any) {
    res.status(500).json({ error: safeError(error) });
  }
});

export default router;
