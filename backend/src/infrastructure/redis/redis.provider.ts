import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/**
 * Redis is used only for rate-limit counters and short-lived caches; nothing durable or
 * financial depends on it. Commands fail fast instead of queueing while disconnected.
 */
@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('Redis');
  readonly client: Redis;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.client = new Redis(config.redis.url, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      commandTimeout: 500,
      connectTimeout: 2_000,
      retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
    });
    // Without a listener ioredis reports connection errors as unhandled.
    this.client.on('error', (error: Error) => {
      this.logger.warn({ err: { message: error.message } }, 'Redis error');
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.client.connect();
    } catch {
      // The API still starts; readiness reports Redis as down and rate limiting falls back.
      this.logger.warn('Redis unavailable at startup');
    }
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.client.quit();
    } catch {
      this.client.disconnect(false);
    }
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }
}
