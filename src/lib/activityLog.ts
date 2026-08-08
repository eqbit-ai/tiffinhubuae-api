import { prisma } from './prisma';

/**
 * Writes an audit row. Never throws.
 *
 * An audit trail must not be able to fail the thing it is auditing — a failed
 * log should not roll back a customer delete or a subscription cancel. But the
 * old frontend helper took that too far: it swallowed the error into a
 * console.error nobody read, and because it also sent two fields that are not
 * columns (`ip_address`, `is_suspicious`) every call failed silently and the
 * feature looked like it worked for months while recording nothing.
 *
 * So: swallow, but shout. A failure here is logged loudly enough to notice.
 */
export async function logActivity(opts: {
  /** Whose activity this is — the account the action affected. */
  userEmail: string;
  userName?: string | null;
  /** snake_case verb, e.g. 'subscription_cancelled'. Shown in the admin UI. */
  actionType: string;
  entityType?: string | null;
  entityId?: string | null;
  description: string;
  metadata?: Record<string, unknown>;
  /** User id the row is owned by — tenant scoping in the entities router keys
   *  on this. For admin actions on someone else, this is the admin. */
  createdBy: string;
}): Promise<void> {
  try {
    await prisma.activityLog.create({
      data: {
        user_email: opts.userEmail,
        user_name: opts.userName ?? null,
        action_type: opts.actionType,
        entity_type: opts.entityType ?? null,
        entity_id: opts.entityId ?? null,
        description: opts.description,
        metadata: (opts.metadata ?? {}) as any,
        created_by: opts.createdBy,
      },
    });
  } catch (err: any) {
    console.error(
      `[ActivityLog] FAILED to record "${opts.actionType}" for ${opts.userEmail}: ${err?.message || err}`
    );
  }
}
