import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

export interface InAppNotification {
  readonly recipientUserId: string;
  /** `domain.event`, e.g. `driver.approved`. */
  readonly eventType: string;
  /** Makes a replay create nothing: `{event}:{aggregate id}:{version}`. */
  readonly dedupeKey: string;
  /** Template keys rendered by the app in the user's language (10 §1). */
  readonly titleKey: string;
  readonly bodyKey: string;
  /** Identifiers and codes only; never names, numbers or document data. */
  readonly params?: Prisma.InputJsonValue;
  readonly deepLink?: string;
}

/**
 * Thin in-app notifications written in the same transaction as the change (13: "phases
 * 5-14 write ... in-app notification rows from the start"). The list API, push and SMS
 * delivery are Phase 15.
 */
@Injectable()
export class NotificationService {
  async notify(db: Prisma.TransactionClient, notification: InAppNotification): Promise<void> {
    await db.notification.createMany({
      data: [
        {
          recipientUserId: notification.recipientUserId,
          eventType: notification.eventType,
          dedupeKey: notification.dedupeKey,
          titleKey: notification.titleKey,
          bodyKey: notification.bodyKey,
          params: notification.params ?? {},
          deepLink: notification.deepLink ?? null,
        },
      ],
      skipDuplicates: true,
    });
  }
}
