import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../config/app-config.js';
import { PrismaService } from './prisma/prisma.service.js';
import { RedisService } from './redis/redis.provider.js';
import { ObjectStorage, S3ObjectStorage } from './storage/object-storage.js';

/** Configuration and infrastructure clients shared by every module. */
@Global()
@Module({})
export class CoreModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: APP_CONFIG, useValue: config },
        PrismaService,
        RedisService,
        { provide: ObjectStorage, useClass: S3ObjectStorage },
      ],
      exports: [APP_CONFIG, PrismaService, RedisService, ObjectStorage],
    };
  }
}
