import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { prisma } from '../lib/prisma';
import { generateDriverToken, driverAuthMiddleware, DriverAuthRequest } from '../middleware/auth';

const router = Router();

// Multer setup for delivery photos
const uploadsDir = path.join(__dirname, '../../uploads');
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: (_req, file, cb) => {
    const uniqueName = `delivery-${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/driver/auth — validate access_code, return driver JWT + merchant info
router.post('/auth', async (req, res) => {
  try {
    const { access_code } = req.body;
    if (!access_code) {
      return res.status(400).json({ error: 'Access code is required' });
    }

    const driver = await prisma.driver.findFirst({
      where: { access_code, is_active: true },
    });

    if (!driver) {
      return res.status(401).json({ error: 'Invalid access code' });
    }

    // Get merchant info
    const merchant = await prisma.user.findUnique({
      where: { id: driver.created_by },
      select: { id: true, business_name: true, full_name: true },
    });

    if (!merchant) {
      return res.status(401).json({ error: 'Merchant not found' });
    }

    const token = generateDriverToken(driver.id, merchant.id);

    res.json({
      token,
      driver: { id: driver.id, name: driver.name, phone: driver.phone },
      merchant: { id: merchant.id, business_name: merchant.business_name || merchant.full_name },
    });
  } catch (error) {
    console.error('[Driver Auth] Error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// GET /api/driver/batches — today's batches assigned to this driver
router.get('/batches', driverAuthMiddleware, async (req: DriverAuthRequest, res) => {
  try {
    const driver = req.driver!;
    const today = new Date().toISOString().split('T')[0];

    const batches = await prisma.deliveryBatch.findMany({
      where: {
        created_by: driver.merchant_id,
        driver_id: driver.id,
        delivery_date: today,
      },
      orderBy: { created_at: 'asc' },
    });

    res.json(batches);
  } catch (error) {
    console.error('[Driver Batches] Error:', error);
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
});

// GET /api/driver/items/:batchId — items in a batch (verified driver owns it)
router.get('/items/:batchId', driverAuthMiddleware, async (req: DriverAuthRequest, res) => {
  try {
    const driver = req.driver!;
    const batchId = req.params.batchId as string;

    // Verify the batch belongs to this driver
    const batch = await prisma.deliveryBatch.findFirst({
      where: {
        id: batchId,
        driver_id: driver.id,
        created_by: driver.merchant_id,
      },
    });

    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    const items = await prisma.deliveryItem.findMany({
      where: { batch_id: batchId },
      orderBy: { created_at: 'asc' },
    });

    res.json(items);
  } catch (error) {
    console.error('[Driver Items] Error:', error);
    res.status(500).json({ error: 'Failed to fetch items' });
  }
});

// PUT /api/driver/items/:itemId/deliver — mark delivered + optional photo URL
router.put('/items/:itemId/deliver', driverAuthMiddleware, async (req: DriverAuthRequest, res) => {
  try {
    const driver = req.driver!;
    const itemId = req.params.itemId as string;
    const { delivery_photo } = req.body;

    // Verify the item belongs to a batch assigned to this driver
    const item = await prisma.deliveryItem.findUnique({ where: { id: itemId } });
    if (!item) {
      return res.status(404).json({ error: 'Item not found' });
    }

    const batch = await prisma.deliveryBatch.findFirst({
      where: {
        id: item.batch_id,
        driver_id: driver.id,
        created_by: driver.merchant_id,
      },
    });

    if (!batch) {
      return res.status(403).json({ error: 'Not authorized for this item' });
    }

    // Update item as delivered
    const updated = await prisma.deliveryItem.update({
      where: { id: itemId },
      data: {
        status: 'delivered',
        delivered_at: new Date(),
        ...(delivery_photo ? { delivery_photo } : {}),
      },
    });

    // Update batch delivered count
    const deliveredCount = await prisma.deliveryItem.count({
      where: { batch_id: item.batch_id, status: 'delivered' },
    });

    await prisma.deliveryBatch.update({
      where: { id: item.batch_id },
      data: {
        delivered_count: deliveredCount,
        status: deliveredCount >= (batch.total_orders || 0) ? 'completed' : 'in_progress',
      },
    });

    res.json(updated);
  } catch (error) {
    console.error('[Driver Deliver] Error:', error);
    res.status(500).json({ error: 'Failed to mark as delivered' });
  }
});

// POST /api/driver/upload-photo — multer file upload, returns URL
router.post('/upload-photo', driverAuthMiddleware, upload.single('photo'), async (req: DriverAuthRequest, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No photo uploaded' });
    }

    const backendUrl = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3001}`;
    const photoUrl = `${backendUrl}/uploads/${req.file.filename}`;

    res.json({ url: photoUrl });
  } catch (error) {
    console.error('[Driver Upload] Error:', error);
    res.status(500).json({ error: 'Failed to upload photo' });
  }
});

export default router;
