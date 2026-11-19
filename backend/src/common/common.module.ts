import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { AuditService } from './audit/audit.service.js';
import { AccessTokenService } from './auth/access-token.service.js';
import { FieldEncryption } from './crypto/field-encryption.js';
import { SecretHasher } from './crypto/secret-hasher.js';
import { IdempotencyService } from './idempotency/idempotency.service.js';
import { NotificationService } from './notifications/notification.service.js';
import { OutboxService } from './outbox/outbox.service.js';
import { RateLimitService } from './rate-limit/rate-limit.service.js';

/** Cross-cutting services used by every module (security, audit, outbox, idempotency). */
@Global()
@Module({
  providers: [
    {
      provide: SecretHasher,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new SecretHasher(config.auth.hashingPepper),
    },
    {
      provide: FieldEncryption,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) =>
        new FieldEncryption(config.fieldEncryption.keys, config.fieldEncryption.activeKeyId),
    },
    AccessTokenService,
    RateLimitService,
    AuditService,
    OutboxService,
    IdempotencyService,
    NotificationService,
  ],
  exports: [
    SecretHasher,
    FieldEncryption,
    AccessTokenService,
    RateLimitService,
    AuditService,
    OutboxService,
    IdempotencyService,
    NotificationService,
  ],
})
export class CommonModule {}
