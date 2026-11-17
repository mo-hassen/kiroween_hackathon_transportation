import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

/**
 * Private S3-compatible object storage (docs/architecture/07-security-architecture.md §4).
 * Phase 2 provides connectivity and health only; presigned upload/download arrives with
 * the documents module (Phase 5). Credentials stay on the server.
 */
export abstract class ObjectStorage {
  abstract isHealthy(timeoutMs: number): Promise<boolean>;
}

@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    super();
    this.bucket = config.storage.bucket;
    this.client = new S3Client({
      region: config.storage.region,
      forcePathStyle: config.storage.forcePathStyle,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
      maxAttempts: 1,
      ...(config.storage.endpoint === undefined ? {} : { endpoint: config.storage.endpoint }),
    });
  }

  async isHealthy(timeoutMs: number): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }), {
        abortSignal: AbortSignal.timeout(timeoutMs),
      });
      return true;
    } catch {
      return false;
    }
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }
}
