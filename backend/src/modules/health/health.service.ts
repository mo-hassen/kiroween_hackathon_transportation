import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { RedisService } from '../../infrastructure/redis/redis.provider.js';
import { ObjectStorage } from '../../infrastructure/storage/object-storage.js';

export type ComponentStatus = 'up' | 'down';

export interface Readiness {
  readonly status: 'ok' | 'unavailable';
  readonly checks: {
    readonly database: ComponentStatus;
    readonly redis: ComponentStatus;
    readonly storage: ComponentStatus;
  };
}

const CHECK_TIMEOUT_MS = 2_000;

async function withTimeout(check: () => Promise<boolean>): Promise<ComponentStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      resolve(false);
    }, CHECK_TIMEOUT_MS);
  });
  try {
    return (await Promise.race([check().catch(() => false), timeout])) ? 'up' : 'down';
  } finally {
    clearTimeout(timer);
  }
}

@Injectable()
export class HealthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly storage: ObjectStorage,
  ) {}

  /**
   * Redis is a hard readiness dependency: without it rate limits are per-instance only,
   * so the load balancer should prefer healthy instances.
   */
  async readiness(): Promise<Readiness> {
    const [database, redis, storage] = await Promise.all([
      withTimeout(async () => {
        await this.prisma.$queryRaw`SELECT 1`;
        return true;
      }),
      withTimeout(() => this.redis.ping()),
      withTimeout(() => this.storage.isHealthy(CHECK_TIMEOUT_MS)),
    ]);
    const allUp = database === 'up' && redis === 'up' && storage === 'up';
    return { status: allUp ? 'ok' : 'unavailable', checks: { database, redis, storage } };
  }
}
