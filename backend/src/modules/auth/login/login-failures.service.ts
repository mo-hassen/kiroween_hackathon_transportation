import { Injectable } from '@nestjs/common';
import { AuditService } from '../../../common/audit/audit.service.js';
import { SecretHasher } from '../../../common/crypto/secret-hasher.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import type { AccountType, Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { lockedUntilAfter } from './lockout.js';

/** Failure bookkeeping shared by customer and staff login. Each call commits on its own. */
@Injectable()
export class LoginFailuresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly hasher: SecretHasher,
  ) {}

  /** Wrong password (or TOTP): increments the counter and locks with backoff. */
  async recordWrongSecret(
    user: { id: string; accountType: AccountType },
    meta: RequestMeta,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const updated = await tx.user.update({
        where: { id: user.id },
        data: { failedLoginCount: { increment: 1 } },
        select: { failedLoginCount: true },
      });
      const lockedUntil = lockedUntilAfter(updated.failedLoginCount, new Date());
      if (lockedUntil !== null) {
        await tx.user.update({ where: { id: user.id }, data: { lockedUntil } });
      }
      await this.audit.record(tx, {
        actor: { type: user.accountType === 'STAFF' ? 'STAFF' : 'USER', userId: user.id },
        action: 'auth.login_failed',
        target: { type: 'user', id: user.id },
        changes: {
          reason: 'WRONG_CREDENTIALS',
          failedLoginCount: updated.failedLoginCount,
          locked: lockedUntil !== null,
        },
        meta,
      });
      if (lockedUntil !== null) {
        await this.audit.record(tx, {
          actor: { type: 'SYSTEM' },
          action: 'auth.account_locked',
          target: { type: 'user', id: user.id },
          changes: {
            lockedUntil: lockedUntil.toISOString(),
            failedLoginCount: updated.failedLoginCount,
          },
          meta,
        });
      }
    });
  }

  /** Unknown number or account that cannot log in: audited by keyed phone hash only. */
  async recordUnknown(
    phoneE164: string,
    reason: 'UNKNOWN_ACCOUNT' | 'LOCKED',
    meta: RequestMeta,
    userId?: string,
  ): Promise<void> {
    await this.audit.record(this.prisma, {
      actor: { type: 'USER', ...(userId === undefined ? {} : { userId }) },
      action: 'auth.login_failed',
      target:
        userId === undefined
          ? { type: 'phone_hash', id: this.hasher.hmacHex('subject', phoneE164) }
          : { type: 'user', id: userId },
      changes: { reason },
      meta,
    });
  }

  async reset(db: Prisma.TransactionClient, userId: string): Promise<void> {
    await db.user.update({
      where: { id: userId },
      data: { failedLoginCount: 0, lockedUntil: null },
    });
  }
}
