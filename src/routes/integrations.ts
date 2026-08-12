import { Router, RequestHandler } from 'express';
import multer from 'multer';
import path from 'path';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { prisma } from '../lib/prisma';
import { sendEmail } from '../services/email';
import { uploadToCloudinary, isCloudinaryConfigured } from '../lib/cloudinary';

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

// File upload config.
//
// This wrote to a local directory and handed back a URL on this host. Railway
// and Render both run containers with ephemeral filesystems, so every redeploy
// deleted the lot: all four merchant logos in production return 404 today, and
// the database still holds the dead URLs. It also pointed image URLs at the API
// host, which is the same host Jio cannot reach — so those logos were invisible
// in India regardless.
//
// Cloudinary was configured on the service the whole time and used correctly by
// the driver photo and menu image routes. This one route was the exception.
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

// Memory, not disk — the buffer goes straight to Cloudinary. Same pattern the
// driver photo route already uses.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter,
});

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

// multer rejects by throwing, which Express turns into an HTML 500 — and the
// client parses responses as JSON, so an oversized file surfaced as a generic
// failure with no cause. Same wrapper as the driver photo route.
const uploadFile: RequestHandler = (req, res, next) => {
  upload.single('file')(req, res, (err: any) => {
    if (!err) return next();
    const tooBig = err?.code === 'LIMIT_FILE_SIZE';
    console.error('[Upload] rejected:', err?.code || err?.message);
    return res.status(400).json({
      error: tooBig
        ? 'That file is too large. Please use one under 10MB.'
        : err?.message || 'That file could not be uploaded.',
    });
  });
};

// POST /api/integrations/upload
router.post('/upload', uploadFile, async (req: AuthRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    // Say so plainly rather than letting the SDK throw. Local development runs
    // deliberately fake credentials, and a merchant should not be told
    // "something went wrong" when the answer is that uploads are not set up.
    if (!isCloudinaryConfigured()) {
      return res.status(503).json({ error: 'File uploads are not configured on this environment.' });
    }

    const isPdf = req.file.mimetype === 'application/pdf';
    const ext = path.extname(req.file.originalname).toLowerCase();
    const publicId = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;

    const fileUrl = await uploadToCloudinary(
      req.file.buffer,
      'tiffinhub/uploads',
      publicId,
      isPdf ? 'raw' : 'image'
    );

    res.json({ file_url: fileUrl, filename: `${publicId}${ext}` });
  } catch (error: any) {
    res.status(500).json({ error: safeError(error) });
  }
});

export default router;
