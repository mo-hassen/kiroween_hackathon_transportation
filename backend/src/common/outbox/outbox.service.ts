import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface OutboxMessage {
  readonly aggregateType: string;
  readonly aggregateId: string;
  /** `domain.event`, e.g. `auth.session_compromised`. */
  readonly eventType: string;
  /** Identifiers and non-sensitive facts only; consumers load details themselves. */
  readonly payload: Prisma.InputJsonValue;
  readonly requestId?: string | undefined;
}

/**
 * Transactional outbox: events are written in the same transaction as the change.
 * Delivery (worker, notifications) is added in later phases
 * (docs/architecture/13-implementation-plan.md).
 */
@Injectable()
export class OutboxService {
  async enqueue(db: Prisma.TransactionClient, message: OutboxMessage): Promise<void> {
    await db.outboxEvent.create({
      data: {
        aggregateType: message.aggregateType,
        aggregateId: message.aggregateId,
        eventType: message.eventType,
        payload: message.payload,
        requestId: message.requestId ?? null,
      },
    });
  }
}
