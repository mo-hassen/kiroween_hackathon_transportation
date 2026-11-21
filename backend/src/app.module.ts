import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import { AuthenticationGuard } from './common/auth/authentication.guard.js';
import { AuthorizationGuard } from './common/auth/authorization.guard.js';
import { CommonModule } from './common/common.module.js';
import { ProblemDetailsFilter } from './common/http/problem-details.filter.js';
import { ResponseEnvelopeInterceptor } from './common/http/response-envelope.interceptor.js';
import { buildPinoHttpParams } from './common/logging/logger.options.js';
import { ResilientThrottlerStorage } from './common/rate-limit/resilient-throttler.storage.js';
import { createValidationPipe } from './common/validation/validation.pipe.js';
import type { AppConfig } from './config/app-config.js';
import { CoreModule } from './infrastructure/core.module.js';
import { RedisService } from './infrastructure/redis/redis.provider.js';
import { AdminModule } from './modules/admin/admin.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { DriversModule } from './modules/drivers/drivers.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { MeModule } from './modules/me/me.module.js';
import { OwnersModule } from './modules/owners/owners.module.js';
import { IdentityProviderModule } from './providers/identity/identity-provider.module.js';
import { ScannerModule } from './providers/scanner/scanner.module.js';
import { SmsModule } from './providers/sms/sms.module.js';

export interface AppModuleOptions {
  /** Test hook: capture structured logs instead of writing to stdout. */
  readonly logDestination?: DestinationStream;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, options: AppModuleOptions = {}): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config),
        CommonModule,
        SmsModule.forRoot(config),
        IdentityProviderModule.forRoot(config),
        ScannerModule.forRoot(config),
        LoggerModule.forRoot({
          pinoHttp: buildPinoHttpParams(config.logLevel, options.logDestination),
        }),
        ThrottlerModule.forRootAsync({
          inject: [RedisService],
          useFactory: (redis: RedisService) => ({
            throttlers: [{ name: 'default', ttl: 60_000, limit: config.rateLimit.perMinute }],
            storage: new ResilientThrottlerStorage({
              eval: (script, numKeys, ...args) => redis.client.eval(script, numKeys, ...args),
            }),
          }),
        }),
        HealthModule,
        AuthModule,
        MeModule,
        AdminModule,
        IdentityModule,
        DocumentsModule,
        DriversModule,
        OwnersModule,
      ],
      providers: [
        // Guard order matters: rate limiting, then authentication, then authorization.
        { provide: APP_GUARD, useClass: ThrottlerGuard },
        { provide: APP_GUARD, useClass: AuthenticationGuard },
        { provide: APP_GUARD, useClass: AuthorizationGuard },
        { provide: APP_FILTER, useClass: ProblemDetailsFilter },
        { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
        { provide: APP_PIPE, useFactory: createValidationPipe },
      ],
    };
  }
}
