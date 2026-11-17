import { Injectable } from '@nestjs/common';
import type { AuditActorType, Prisma } from '../../generated/prisma/client.js';
import type { RequestMeta } from '../http/request-meta.js';

export type DbClient = Prisma.TransactionClient;

export interface AuditEntry {
  readonly actor: { readonly type: AuditActorType; readonly userId?: string | undefined };
  /** `domain.verb_noun`, e.g. `auth.login_failed`. */
  readonly action: string;
  readonly target?: { readonly type: string; readonly id: string };
  readonly reason?: string;
  /** Whitelisted, non-sensitive facts only. Never passwords, codes, tokens or secrets. */
  readonly changes?: Prisma.InputJsonValue;
  readonly meta?: RequestMeta;
}

/**
 * Writes audit rows. Pass the transaction client of the change being audited, so the
 * change and its audit record commit or roll back together
 * (docs/architecture/10-notifications-disputes-audit.md §5).
 */
@Injectable()
export class AuditService {
  async record(db: DbClient, entry: AuditEntry): Promise<void> {
    await db.auditLog.create({
      data: {
        actorType: entry.actor.type,
        actorUserId: entry.actor.userId ?? null,
        action: entry.action,
        targetType: entry.target?.type ?? null,
        targetId: entry.target?.id ?? null,
        reason: entry.reason ?? null,
        ...(entry.changes === undefined ? {} : { changes: entry.changes }),
        requestId: entry.meta?.requestId ?? null,
        ip: entry.meta?.ip ?? null,
        userAgent: entry.meta?.userAgent ?? null,
      },
    });
  }
}
