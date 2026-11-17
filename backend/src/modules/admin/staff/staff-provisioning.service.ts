import { Injectable } from '@nestjs/common';
import { normalizeActivationCode, randomActivationCode } from '../../../common/crypto/random.js';
import type { Prisma, StaffRole } from '../../../generated/prisma/client.js';
import { AUTH_POLICY } from '../../auth/auth-policy.js';
import { OtpChallengeService } from '../../auth/otp/otp-challenge.service.js';
import { UNUSABLE_PASSWORD_HASH } from '../../auth/password/password.service.js';

export interface Activation {
  /** Display form XXXX-XXXX-XXXX; only its keyed hash is stored. */
  readonly code: string;
  readonly expiresAt: Date;
}

/**
 * Creates staff accounts and their one-time activation codes. Used by the admin API and
 * by the bootstrap CLI. A new staff account cannot log in until its holder sets a
 * password and enrolls an authenticator app (PENDING_ACTIVATION -> ACTIVE).
 */
@Injectable()
export class StaffProvisioningService {
  constructor(private readonly otp: OtpChallengeService) {}

  async createStaff(
    tx: Prisma.TransactionClient,
    input: {
      phoneE164: string;
      displayName: string;
      roles: readonly StaffRole[];
      grantedById: string | null;
    },
  ): Promise<{ userId: string; activation: Activation }> {
    const user = await tx.user.create({
      data: {
        phoneE164: input.phoneE164,
        passwordHash: UNUSABLE_PASSWORD_HASH,
        accountType: 'STAFF',
        status: 'PENDING_ACTIVATION',
        displayName: input.displayName,
      },
      select: { id: true },
    });
    for (const role of input.roles) {
      await tx.staffRoleAssignment.create({
        data: { userId: user.id, role, grantedById: input.grantedById },
      });
    }
    return {
      userId: user.id,
      activation: await this.issueActivation(tx, user.id, input.phoneE164),
    };
  }

  async issueActivation(
    tx: Prisma.TransactionClient,
    userId: string,
    phoneE164: string,
  ): Promise<Activation> {
    const code = randomActivationCode();
    const issued = await this.otp.issue(tx, {
      purpose: 'STAFF_ACTIVATION',
      phoneE164,
      userId,
      code: normalizeActivationCode(code),
      ttlMs: AUTH_POLICY.staffActivationTtlMs,
      maxAttempts: AUTH_POLICY.staffActivationMaxAttempts,
    });
    return { code, expiresAt: issued.expiresAt };
  }
}
