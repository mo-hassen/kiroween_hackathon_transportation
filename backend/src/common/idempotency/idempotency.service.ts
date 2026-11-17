import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { SecretHasher } from '../crypto/secret-hasher.js';
import { DomainError, ErrorCode } from '../http/problem-details.js';

export const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;

export interface IdempotentRequest {
  /** Operation name, e.g. `auth.register`. */
  readonly scope: string;
  /** `user:<id>` for authenticated calls, `anonymous` for public ones. */
  readonly principal: string;
  readonly key: string;
  /** Method, route and body that the key is bound to. */
  readonly fingerprint: { readonly method: string; readonly route: string; readonly body: unknown };
}

export interface IdempotentResponse {
  readonly status: number;
  /** Response data before the `{ data }` envelope. Must not contain secrets: it is stored. */
  readonly body: Prisma.InputJsonValue;
}

export interface IdempotentResult extends IdempotentResponse {
  readonly replayed: boolean;
}

/** Stable JSON: object keys sorted recursively, so key order does not change the hash. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  // JSON.stringify returns undefined for undefined/functions/symbols despite its type.
  const encoded = JSON.stringify(value) as string | undefined;
  return encoded ?? 'null';
}

/**
 * Exactly-once execution for retried mutations (docs/architecture/04-api-architecture.md).
 *
 * The record is claimed, the work runs and the response is stored in ONE database
 * transaction. A concurrent duplicate blocks on the unique key until the first commits,
 * then replays its response; if the first rolls back, nothing is stored and the
 * duplicate runs normally. Failures are never cached.
 *
 * The request fingerprint is HMAC-hashed: bodies can contain passwords and codes.
 */
@Injectable()
export class IdempotencyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hasher: SecretHasher,
  ) {}

  async execute(
    request: IdempotentRequest,
    work: (tx: Prisma.TransactionClient) => Promise<IdempotentResponse>,
  ): Promise<IdempotentResult> {
    const { method, route, body } = request.fingerprint;
    const requestHash = this.hasher.hmacHex(
      'idempotency',
      `${method.toUpperCase()} ${route}\n${canonicalJson(body)}`,
    );
    const where = {
      scope_principal_key: { scope: request.scope, principal: request.principal, key: request.key },
    };

    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const claimed = await tx.idempotencyRecord.createMany({
        data: [
          {
            scope: request.scope,
            principal: request.principal,
            key: request.key,
            requestHash,
            lockedUntil: now,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        ],
        skipDuplicates: true,
      });

      if (claimed.count === 0) {
        const existing = await tx.idempotencyRecord.findUnique({ where });
        if (existing !== null && existing.expiresAt > now) {
          if (existing.requestHash !== requestHash) {
            throw new DomainError(
              ErrorCode.IDEMPOTENCY_KEY_REUSED,
              HttpStatus.UNPROCESSABLE_ENTITY,
            );
          }
          if (existing.status === 'COMPLETED' && existing.responseStatus !== null) {
            return {
              status: existing.responseStatus,
              body: existing.responseBody ?? {},
              replayed: true,
            };
          }
          throw new DomainError(ErrorCode.REQUEST_IN_PROGRESS, HttpStatus.CONFLICT);
        }
        // Expired record that was not purged yet: take it over for this request.
        await tx.idempotencyRecord.update({
          where,
          data: {
            requestHash,
            status: 'IN_PROGRESS',
            responseStatus: null,
            lockedUntil: now,
            expiresAt: new Date(now.getTime() + IDEMPOTENCY_TTL_MS),
          },
        });
      }

      const response = await work(tx);
      await tx.idempotencyRecord.update({
        where,
        data: { status: 'COMPLETED', responseStatus: response.status, responseBody: response.body },
      });
      return { ...response, replayed: false };
    });
  }
}
