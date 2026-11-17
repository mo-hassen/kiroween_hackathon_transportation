import { Injectable } from '@nestjs/common';
import { rateLimitedError } from '../http/problem-details.js';
import { SecretHasher } from '../crypto/secret-hasher.js';
import { RedisService } from '../../infrastructure/redis/redis.provider.js';
import { ResilientThrottlerStorage } from './resilient-throttler.storage.js';

export interface RateLimitRule {
  /** Stable bucket name, part of the Redis key. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

/**
 * Named sliding-window limits for business rules (OTP sends per phone, logins per IP,
 * requests per user). Subjects are HMAC-hashed so Redis never holds phone numbers or
 * IP addresses. Uses the same Redis script and in-memory fallback as the global throttler.
 */
@Injectable()
export class RateLimitService {
  private readonly storage: ResilientThrottlerStorage;

  constructor(
    redis: RedisService,
    private readonly hasher: SecretHasher,
  ) {
    this.storage = new ResilientThrottlerStorage(
      { eval: (script, numKeys, ...args) => redis.client.eval(script, numKeys, ...args) },
      'rl:biz:',
    );
  }

  /** Records one hit; throws 429 RATE_LIMITED (with Retry-After) once the limit is exceeded. */
  async consume(rule: RateLimitRule, subject: string): Promise<void> {
    const key = this.hasher.hmacHex('subject', subject);
    const record = await this.storage.increment(
      key,
      rule.windowMs,
      rule.limit,
      rule.windowMs,
      rule.name,
    );
    if (record.isBlocked) {
      throw rateLimitedError(record.timeToBlockExpire);
    }
  }
}
