import { Injectable } from '@nestjs/common';
import { randomNumericCode, randomToken } from '../../../common/crypto/random.js';
import { hexDigestsEqual, SecretHasher } from '../../../common/crypto/secret-hasher.js';
import { uuidv7 } from '../../../common/crypto/uuid.js';
import type { OtpChallenge, OtpPurpose, Prisma } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';

export interface IssueChallenge {
  readonly purpose: OtpPurpose;
  readonly phoneE164: string;
  readonly userId?: string;
  readonly installationId?: string;
  readonly ttlMs: number;
  readonly maxAttempts: number;
  /** Supply a code (staff activation); otherwise a 6-digit code is generated. */
  readonly code?: string | null;
  /** Also return an opaque ticket that identifies the challenge (multi-step flows). */
  readonly withTicket?: boolean;
}

export interface IssuedChallenge {
  readonly challengeId: string;
  readonly code: string | null;
  readonly ticket: string | null;
  readonly expiresAt: Date;
}

/**
 * One-time challenges with hashed codes, expiry and bounded attempts
 * (docs/architecture/07-security-architecture.md §1).
 *
 * Verification is two-phase on purpose: `attempt` increments the attempt counter in its
 * own autocommitted statement BEFORE comparing, so a failed guess is always counted even
 * if the caller's transaction later rolls back; `consume` then marks the challenge used
 * inside the caller's transaction, exactly once.
 */
@Injectable()
export class OtpChallengeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: SecretHasher,
  ) {}

  async issue(db: Prisma.TransactionClient, input: IssueChallenge): Promise<IssuedChallenge> {
    const code = input.code === null ? null : (input.code ?? randomNumericCode(6));
    const ticket = input.withTicket === true ? randomToken() : null;
    const expiresAt = new Date(Date.now() + input.ttlMs);
    // The id is generated here so the code hash can be bound to it in the same insert.
    const challengeId = uuidv7();
    await db.otpChallenge.create({
      data: {
        id: challengeId,
        purpose: input.purpose,
        phoneE164: input.phoneE164,
        userId: input.userId ?? null,
        installationId: input.installationId ?? null,
        codeHash: code === null ? null : this.codeHash(challengeId, code),
        ticketHash: ticket === null ? null : this.hasher.hmacHex('ticket', ticket),
        maxAttempts: input.maxAttempts,
        expiresAt,
      },
      select: { id: true },
    });
    return { challengeId, code, ticket, expiresAt };
  }

  /** Verifies a code against the newest challenge for (phone, purpose). */
  async attemptLatest(
    purpose: OtpPurpose,
    phoneE164: string,
    code: string,
  ): Promise<OtpChallenge | null> {
    const latest = await this.prisma.otpChallenge.findFirst({
      where: { purpose, phoneE164 },
      orderBy: { createdAt: 'desc' },
    });
    return this.attempt(latest, code);
  }

  /** Verifies a ticket (and the code, when the challenge has one). */
  async attemptByTicket(
    purpose: OtpPurpose,
    ticket: string,
    code: string | null,
  ): Promise<OtpChallenge | null> {
    const challenge = await this.prisma.otpChallenge.findUnique({
      where: { ticketHash: this.hasher.hmacHex('ticket', ticket) },
    });
    if (challenge?.purpose !== purpose) return null;
    return this.attempt(challenge, code);
  }

  /** Marks the challenge used. Returns false if it was consumed concurrently. */
  async consume(db: Prisma.TransactionClient, challengeId: string): Promise<boolean> {
    const result = await db.otpChallenge.updateMany({
      where: { id: challengeId, consumedAt: null },
      data: { consumedAt: new Date() },
    });
    return result.count === 1;
  }

  private async attempt(
    challenge: OtpChallenge | null,
    code: string | null,
  ): Promise<OtpChallenge | null> {
    if (challenge === null) return null;
    // Count the attempt first (atomic, outside any caller transaction).
    const counted = await this.prisma.otpChallenge.updateMany({
      where: {
        id: challenge.id,
        consumedAt: null,
        expiresAt: { gt: new Date() },
        attempts: { lt: challenge.maxAttempts },
      },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count !== 1) return null;
    if (challenge.codeHash === null) return code === null ? challenge : null;
    if (code === null) return null;
    return hexDigestsEqual(challenge.codeHash, this.codeHash(challenge.id, code))
      ? challenge
      : null;
  }

  private codeHash(challengeId: string, code: string): string {
    return this.hasher.hmacHex('otp', `${challengeId}:${code}`);
  }
}
