import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { authMiddleware, checkActiveSubscription, AuthRequest } from '../middleware/auth';

const router = Router();

// Date fields that need ISO conversion per entity
const dateFields = new Set([
  'start_date', 'end_date', 'due_date', 'last_payment_date', 'deleted_at',
  'pause_start', 'pause_end', 'trial_ends_at', 'subscription_ends_at',
  'current_period_end', 'next_billing_date', 'cancelled_at', 'trial_cancelled_at',
  'subscription_start_date', 'payment_date', 'expires_at', 'paid_at',
  'trial_end_date', 'period_start', 'period_end',
  'given_date', 'last_reminder', 'delivered_at', 'prepared_at',
  'resolved_at', 'resolved_date',
]);

// Boolean fields that may arrive as strings from CSV imports
const booleanFields = new Set([
  'active', 'is_deleted', 'is_paused', 'skip_weekends', 'is_active', 'is_critical',
  'carry_forward_applied', 'read', 'is_read', 'email_sent', 'notification_sent',
  'reminder_before_sent', 'reminder_after_sent', 'is_trial', 'trial_converted',
  'is_active', 'deposit_paid', 'discount_applied',
]);

// Fields that are Float/Int in Prisma — empty strings must become null or 0
const numericFields = new Set([
  'payment_amount', 'last_payment_amount', 'paid_days', 'delivered_days', 'days_remaining',
  'meals_delivered', 'tiffin_balance', 'roti_quantity', 'total_pause_days',
  'price', 'current_stock', 'min_stock_threshold', 'cost_per_unit', 'total_value',
  'total_cost', 'cost_per_serving', 'quantity', 'cost_value',
  'amount', 'tax_amount', 'total_amount', 'platform_fee_amount', 'net_amount',
  'discount_amount', 'billing_amount', 'capacity', 'given_count', 'returned_count',
  'outstanding', 'deposit_amount', 'count', 'quantity_prepared', 'cost_per_meal',
  'rating', 'total_orders', 'delivered_count', 'fee_percentage',
]);

// Sanitize empty strings: convert to null for non-string fields
function sanitizeEmptyStrings(data: any) {
  for (const key of Object.keys(data)) {
    if (data[key] === '') {
      if (numericFields.has(key) || dateFields.has(key) || booleanFields.has(key)) {
        data[key] = null;
      }
    }
    // Convert string numbers to actual numbers for numeric fields
    if (numericFields.has(key) && typeof data[key] === 'string' && data[key] !== '') {
      const parsed = Number(data[key]);
      data[key] = isNaN(parsed) ? null : parsed;
    }
  }
  return data;
}

function coerceBooleans(data: any) {
  for (const key of Object.keys(data)) {
    if (booleanFields.has(key) && typeof data[key] === 'string') {
      data[key] = data[key] === 'true' || data[key] === '1';
    }
  }
  return data;
}

// Convert date-like strings to proper ISO DateTime
function coerceDates(data: any) {
  for (const key of Object.keys(data)) {
    if (dateFields.has(key) && typeof data[key] === 'string') {
      if (!data[key]) {
        data[key] = null;
        continue;
      }
      // If it's just a date like "2026-01-01", make it a full ISO datetime
      if (/^\d{4}-\d{2}-\d{2}$/.test(data[key])) {
        data[key] = new Date(data[key] + 'T00:00:00.000Z');
      } else {
        data[key] = new Date(data[key]);
      }
      // If invalid date, set to null
      if (isNaN(data[key].getTime())) {
        data[key] = null;
      }
    }
  }
  return data;
}

// Add Base44-compatible virtual fields to response records
function addVirtualFields(record: any) {
  if (!record || typeof record !== 'object') return record;
  if (record.created_at) record.created_date = record.created_at;
  if (record.updated_at) record.updated_date = record.updated_at;
  return record;
}

function addVirtualFieldsArray(records: any[]) {
  return records.map(addVirtualFields);
}

// Map of entity names to Prisma model delegates + config
const entityConfig: Record<string, {
  model: any;
  ownerField: string;        // field used for tenant isolation
  ownerValue: 'id' | 'email'; // whether owner field stores user id or email
  softDelete?: boolean;
  listAll?: boolean;          // if true, no tenant filter on list (e.g. notifications filter by email)
}> = {
  customers: { model: () => prisma.customer, ownerField: 'created_by', ownerValue: 'id', softDelete: true },
  orders: { model: () => prisma.order, ownerField: 'created_by', ownerValue: 'id' },
  menu_items: { model: () => prisma.menuItem, ownerField: 'created_by', ownerValue: 'id' },
  tiffin_skips: { model: () => prisma.tiffinSkip, ownerField: 'created_by', ownerValue: 'id' },
  notifications: { model: () => prisma.notification, ownerField: 'user_email', ownerValue: 'email' },
  activity_logs: { model: () => prisma.activityLog, ownerField: 'created_by', ownerValue: 'id' },
  ingredients: { model: () => prisma.ingredient, ownerField: 'created_by', ownerValue: 'id' },
  recipes: { model: () => prisma.recipe, ownerField: 'created_by', ownerValue: 'id' },
  suppliers: { model: () => prisma.supplier, ownerField: 'created_by', ownerValue: 'id' },
  purchases: { model: () => prisma.purchase, ownerField: 'created_by', ownerValue: 'id' },
  wastages: { model: () => prisma.wastage, ownerField: 'created_by', ownerValue: 'id' },
  support_tickets: { model: () => prisma.supportTicket, ownerField: 'user_email', ownerValue: 'email' },
  subscriptions: { model: () => prisma.subscription, ownerField: 'user_email', ownerValue: 'email' },
  payment_history: { model: () => prisma.paymentHistory, ownerField: 'user_email', ownerValue: 'email' },
  payment_links: { model: () => prisma.paymentLink, ownerField: 'created_by', ownerValue: 'id' },
  consumption_logs: { model: () => prisma.consumptionLog, ownerField: 'created_by', ownerValue: 'id' },
  meal_ratings: { model: () => prisma.mealRating, ownerField: 'created_by', ownerValue: 'id' },
  invoices: { model: () => prisma.invoice, ownerField: 'created_by', ownerValue: 'id' },
  referrals: { model: () => prisma.referral, ownerField: 'created_by', ownerValue: 'id' },
  family_groups: { model: () => prisma.familyGroup, ownerField: 'created_by', ownerValue: 'id' },
  drivers: { model: () => prisma.driver, ownerField: 'created_by', ownerValue: 'id' },
  delivery_batches: { model: () => prisma.deliveryBatch, ownerField: 'created_by', ownerValue: 'id' },
  delivery_items: { model: () => prisma.deliveryItem, ownerField: 'created_by', ownerValue: 'id' },
  containers: { model: () => prisma.container, ownerField: 'created_by', ownerValue: 'id' },
  container_logs: { model: () => prisma.containerLog, ownerField: 'created_by', ownerValue: 'id' },
  kitchens: { model: () => prisma.kitchen, ownerField: 'created_by', ownerValue: 'id' },
  prep_items: { model: () => prisma.prepItem, ownerField: 'created_by', ownerValue: 'id' },
  chat_messages: { model: () => prisma.chatMessage, ownerField: 'created_by', ownerValue: 'id' },
  one_time_orders: { model: () => prisma.oneTimeOrder, ownerField: 'created_by', ownerValue: 'id' },
  system_logs: { model: () => prisma.systemLog, ownerField: 'created_by', ownerValue: 'id', listAll: true },
};

// Helper to build where clause with tenant isolation
function buildWhere(config: typeof entityConfig[string], user: AuthRequest['user'], filters: any = {}) {
  const where: any = { ...filters };

  // Remove frontend-supplied created_by / user_email — backend enforces tenant isolation
  delete where.created_by;
  delete where.user_email;

  // Convert MongoDB-style operators to Prisma equivalents
  for (const key of Object.keys(where)) {
    if (where[key] && typeof where[key] === 'object' && !Array.isArray(where[key])) {
      const val = where[key];
      if ('$ne' in val) { where[key] = { not: val.$ne }; }
      else if ('$gt' in val) { where[key] = { gt: val.$gt }; }
      else if ('$gte' in val) { where[key] = { gte: val.$gte }; }
      else if ('$lt' in val) { where[key] = { lt: val.$lt }; }
      else if ('$lte' in val) { where[key] = { lte: val.$lte }; }
      else if ('$in' in val) { where[key] = { in: val.$in }; }
    }
  }

  if (config.ownerField) {
    where[config.ownerField] = config.ownerValue === 'email' ? user!.email : user!.id;
  }
  if (config.softDelete) {
    where.is_deleted = filters.is_deleted ?? false;
  }
  return where;
}

// Super admin check
function isSuperAdmin(user: AuthRequest['user']): boolean {
  const DEFAULT_SUPER_ADMIN = process.env.SUPER_ADMIN_EMAIL || 'support@tiffinhub.me';
  return user?.email === DEFAULT_SUPER_ADMIN || user?.is_super_admin === true;
}

// ─── Admin routes (must be before /:entity wildcard) ─────────

// GET /api/admin/users (super admin only)
router.get('/admin/users', authMiddleware, async (req: AuthRequest, res) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const users = await prisma.user.findMany({
      select: {
        id: true, email: true, full_name: true, role: true,
        subscription_status: true, plan_type: true, subscription_source: true,
        is_super_admin: true, special_access_type: true,
        trial_ends_at: true, subscription_ends_at: true,
        stripe_customer_id: true, stripe_subscription_id: true,
        currency: true, created_at: true,
      },
      orderBy: { created_at: 'desc' },
    });
    res.json(addVirtualFieldsArray(users));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/admin/users/:id (super admin only)
router.put('/admin/users/:id', authMiddleware, async (req: AuthRequest, res) => {
  if (!isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const allowedFields = new Set([
      'full_name', 'business_name', 'role', 'is_super_admin', 'special_access_type',
      'subscription_status', 'plan_type', 'subscription_source',
      'trial_ends_at', 'subscription_ends_at',
    ]);
    const updateData: Record<string, any> = {};
    for (const field of allowedFields) {
      if (field in req.body) updateData[field] = req.body[field];
    }

    const user = await prisma.user.update({
      where: { id: req.params.id as string },
      data: updateData,
    });
    const { password_hash: _, ...safeUser } = user;
    res.json(safeUser);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/:entity - list with filters
router.get('/:entity', authMiddleware, async (req: AuthRequest, res) => {
  const entity = req.params.entity as string;
  const config = entityConfig[entity];
  if (!config) return res.status(404).json({ error: 'Unknown entity' });

  // Restrict listAll entities (e.g. system_logs) to super admins
  if (config.listAll && !isSuperAdmin(req.user)) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { where: whereJson, sortBy, limit, offset, all } = req.query as Record<string, string | undefined>;
    let filters: any = {};
    if (whereJson) {
      try { filters = JSON.parse(whereJson as string); } catch {}
    }

    // Super admins with ?all=true (or listAll entities) can bypass tenant isolation
    const bypassTenant = (all === 'true' || config.listAll) && isSuperAdmin(req.user);
    const where = bypassTenant ? filters : buildWhere(config, req.user, filters);

    // Map common Base44 field names to Prisma column names
    const fieldNameMap: Record<string, string> = {
      created_date: 'created_at',
      updated_date: 'updated_at',
      order_date: 'created_at',
    };
    const mapField = (f: string) => fieldNameMap[f] || f;

    let orderBy: any = { created_at: 'desc' };
    if (sortBy) {
      try {
        const parsed = JSON.parse(sortBy as string);
        if (typeof parsed === 'string') {
          // Handle Base44-style sort: "-field_name" for desc, "field_name" for asc
          if (parsed.startsWith('-')) {
            orderBy = { [mapField(parsed.slice(1))]: 'desc' };
          } else {
            orderBy = { [mapField(parsed)]: 'asc' };
          }
        } else if (Array.isArray(parsed)) {
          orderBy = parsed.map((s: any) => ({ [mapField(s.field)]: s.direction || 'asc' }));
        } else if (parsed.field) {
          orderBy = { [mapField(parsed.field)]: parsed.direction || 'asc' };
        }
      } catch {
        // sortBy might be a plain string (not JSON)
        if (typeof sortBy === 'string') {
          if (sortBy.startsWith('-')) {
            orderBy = { [mapField(sortBy.slice(1))]: 'desc' };
          } else {
            orderBy = { [mapField(sortBy)]: 'asc' };
          }
        }
      }
    }

    const results = await config.model().findMany({
      where,
      orderBy,
      take: limit ? parseInt(limit as string) : undefined,
      skip: offset ? parseInt(offset as string) : undefined,
    });

    res.json(addVirtualFieldsArray(results));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/:entity/:id
router.get('/:entity/:id', authMiddleware, async (req: AuthRequest, res) => {
  const config = entityConfig[req.params.entity as string];
  if (!config) return res.status(404).json({ error: 'Unknown entity' });

  try {
    const record = await config.model().findUnique({ where: { id: req.params.id } });
    if (!record) return res.status(404).json({ error: 'Not found' });

    // Ownership check
    if (config.ownerField && !isSuperAdmin(req.user)) {
      const ownerVal = config.ownerValue === 'email' ? req.user!.email : req.user!.id;
      if ((record as any)[config.ownerField] !== ownerVal) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    res.json(addVirtualFields(record));
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/:entity
router.post('/:entity', authMiddleware, checkActiveSubscription, async (req: AuthRequest, res) => {
  const config = entityConfig[req.params.entity as string];
  if (!config) return res.status(404).json({ error: 'Unknown entity' });

  try {
    const data = { ...req.body };

    // Remove id if provided (auto-generated)
    delete data.id;

    // Auto-set owner field
    if (config.ownerField) {
      data[config.ownerField] = config.ownerValue === 'email' ? req.user!.email : req.user!.id;
    }

    // Remove fields that look like they came from Base44 but aren't in Prisma
    delete data.created_date;
    delete data.updated_date;

    sanitizeEmptyStrings(data);
    coerceBooleans(data);
    coerceDates(data);

    // MenuItem: derive 'name' from 'item_name' if not provided (name is required in schema)
    if (req.params.entity === 'menu_items' && !data.name && data.item_name) {
      data.name = data.item_name;
    }

    const record = await config.model().create({ data });
    res.status(201).json(addVirtualFields(record));
  } catch (error: any) {
    // If it's a Prisma unknown field error, try again stripping unknown fields
    if (error.code === 'P2009' || error.message?.includes('Unknown argument') || error.message?.includes('Unknown field')) {
      try {
        // Get model fields by attempting with only known safe fields
        const safeData: any = {};
        const safeFields = Object.keys(req.body);
        for (const key of safeFields) {
          safeData[key] = req.body[key];
        }
        if (config.ownerField) {
          safeData[config.ownerField] = config.ownerValue === 'email' ? req.user!.email : req.user!.id;
        }
        delete safeData.id;
        delete safeData.created_date;
        delete safeData.updated_date;
        const record = await config.model().create({ data: safeData });
        return res.status(201).json(addVirtualFields(record));
      } catch {}
    }
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/:entity/:id
router.put('/:entity/:id', authMiddleware, checkActiveSubscription, async (req: AuthRequest, res) => {
  const entity = req.params.entity as string;
  const id = req.params.id as string;
  console.log(`[PUT] → ${entity}/${id} by user ${req.user?.id}`);

  const config = entityConfig[entity];
  if (!config) {
    console.log(`[PUT] Unknown entity: ${entity}`);
    return res.status(404).json({ error: 'Unknown entity' });
  }

  try {
    const existing = await config.model().findUnique({ where: { id } });
    if (!existing) {
      console.log(`[PUT] Not found: ${entity}/${id}`);
      return res.status(404).json({ error: 'Not found' });
    }

    // Ownership check
    if (config.ownerField && !isSuperAdmin(req.user)) {
      const ownerVal = config.ownerValue === 'email' ? req.user!.email : req.user!.id;
      if ((existing as any)[config.ownerField] !== ownerVal) {
        console.log(`[PUT] Access denied: ${entity}/${id} owner=${(existing as any)[config.ownerField]} user=${ownerVal}`);
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    let updateData = { ...req.body };
    // Strip read-only / virtual / relation fields
    const stripFields = [
      'id', 'created_date', 'updated_date', 'created_by', 'created_at', 'updated_at',
      'creator', 'customer', 'customerRef', 'orders', 'tiffinSkips', 'paymentLinks',
      'ingredient', 'wastages', 'user_email', 'skipRecords', 'delivered_time',
    ];
    for (const f of stripFields) delete updateData[f];
    sanitizeEmptyStrings(updateData);
    coerceBooleans(updateData);
    coerceDates(updateData);

    console.log('[PUT] updateData keys:', Object.keys(updateData));
    let record;
    try {
      record = await config.model().update({ where: { id }, data: updateData });
    } catch (innerErr: any) {
      console.log('[PUT] innerErr:', innerErr.message?.slice(0, 300));
      // If Prisma rejects unknown fields, strip them and retry
      if (innerErr.message?.includes('Unknown arg') || innerErr.message?.includes('Unknown field') || innerErr.message?.includes('Unknown argument')) {
        const matches = innerErr.message.match(/Unknown (?:arg|argument|field) `(\w+)`/g) || [];
        for (const m of matches) {
          const field = m.match(/`(\w+)`/)?.[1];
          if (field) {
            console.log(`[PUT] Stripping unknown field: ${field}`);
            delete updateData[field];
          }
        }
        record = await config.model().update({ where: { id }, data: updateData });
      } else {
        throw innerErr;
      }
    }
    console.log(`[PUT] ✓ ${entity}/${id} updated`);
    res.json(addVirtualFields(record));
  } catch (error: any) {
    console.error(`[PUT] ✗ ${entity}/${id} error:`, error.message?.slice(0, 300));
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/:entity/:id
router.delete('/:entity/:id', authMiddleware, checkActiveSubscription, async (req: AuthRequest, res) => {
  const config = entityConfig[req.params.entity as string];
  if (!config) return res.status(404).json({ error: 'Unknown entity' });

  try {
    const existing = await config.model().findUnique({ where: { id: req.params.id } });
    if (!existing) return res.status(404).json({ error: 'Not found' });

    // Ownership check
    if (config.ownerField && !isSuperAdmin(req.user)) {
      const ownerVal = config.ownerValue === 'email' ? req.user!.email : req.user!.id;
      if ((existing as any)[config.ownerField] !== ownerVal) {
        return res.status(403).json({ error: 'Access denied' });
      }
    }

    if (config.softDelete) {
      await config.model().update({
        where: { id: req.params.id },
        data: { is_deleted: true, deleted_at: new Date() },
      });
    } else {
      await config.model().delete({ where: { id: req.params.id } });
    }

    res.json({ success: true });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

export default router;
