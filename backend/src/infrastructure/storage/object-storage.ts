import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';

export interface PresignedRequest {
  readonly url: string;
  readonly method: 'PUT' | 'GET';
  /** Headers the client must send unchanged (they are part of the signature). */
  readonly headers: Readonly<Record<string, string>>;
  readonly expiresAt: Date;
}

export interface StoredObjectInfo {
  readonly sizeBytes: number;
  readonly contentType: string | undefined;
}

export class ObjectTooLargeError extends Error {
  constructor() {
    super('Stored object is larger than allowed');
    this.name = 'ObjectTooLargeError';
  }
}

/**
 * Private S3-compatible object storage (docs/architecture/07-security-architecture.md §4).
 * The bucket is never public: clients only get short-lived presigned URLs for one object
 * and one method. Credentials stay on the server.
 */
export abstract class ObjectStorage {
  abstract isHealthy(timeoutMs: number): Promise<boolean>;
  /** PUT URL bound to the key, content type and exact content length. */
  abstract presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedRequest>;
  /** GET URL with forced content type, disposition and `Cache-Control: private, no-store`. */
  abstract presignGet(
    key: string,
    options: {
      contentType: string;
      disposition: 'inline' | 'attachment';
      fileName: string;
      expiresInSeconds: number;
    },
  ): Promise<PresignedRequest>;
  /** Null when the object does not exist. */
  abstract head(key: string): Promise<StoredObjectInfo | null>;
  /** Reads the whole object; throws ObjectTooLargeError above maxBytes. */
  abstract read(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Server-side write with the configured server-side encryption. */
  abstract write(key: string, body: Buffer, contentType: string): Promise<void>;
  abstract delete(key: string): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  const meta = (error as { $metadata?: { httpStatusCode?: number }; name?: string } | null) ?? {};
  return (
    meta.$metadata?.httpStatusCode === 404 || meta.name === 'NotFound' || meta.name === 'NoSuchKey'
  );
}

@Injectable()
export class S3ObjectStorage extends ObjectStorage implements OnModuleDestroy {
  private readonly client: S3Client;
  /** Signs URLs with the endpoint clients can reach; never sends requests itself. */
  private readonly presigner: S3Client;
  private readonly bucket: string;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {
    super();
    this.bucket = config.storage.bucket;
    const base: S3ClientConfig = {
      region: config.storage.region,
      forcePathStyle: config.storage.forcePathStyle,
      credentials: {
        accessKeyId: config.storage.accessKeyId,
        secretAccessKey: config.storage.secretAccessKey,
      },
      maxAttempts: 2,
      // Checksums are verified by the documents module itself (SHA-256 of the bytes).
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    };
    this.client = new S3Client({
      ...base,
      ...(config.storage.endpoint === undefined ? {} : { endpoint: config.storage.endpoint }),
    });
    const publicEndpoint = config.storage.publicEndpoint;
    this.presigner = new S3Client({
      ...base,
      ...(publicEndpoint === undefined ? {} : { endpoint: publicEndpoint }),
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

  async presignPut(
    key: string,
    options: { contentType: string; contentLength: number; expiresInSeconds: number },
  ): Promise<PresignedRequest> {
    const url = await getSignedUrl(
      this.presigner,
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ContentType: options.contentType,
        ContentLength: options.contentLength,
      }),
      {
        expiresIn: options.expiresInSeconds,
        signableHeaders: new Set(['content-type', 'content-length']),
      },
    );
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': options.contentType },
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async presignGet(
    key: string,
    options: {
      contentType: string;
      disposition: 'inline' | 'attachment';
      fileName: string;
      expiresInSeconds: number;
    },
  ): Promise<PresignedRequest> {
    const url = await getSignedUrl(
      this.presigner,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentType: options.contentType,
        ResponseContentDisposition: `${options.disposition}; filename="${options.fileName}"`,
        ResponseCacheControl: 'private, no-store, max-age=0',
      }),
      { expiresIn: options.expiresInSeconds },
    );
    return {
      url,
      method: 'GET',
      headers: {},
      expiresAt: new Date(Date.now() + options.expiresInSeconds * 1000),
    };
  }

  async head(key: string): Promise<StoredObjectInfo | null> {
    try {
      const result = await this.client.send(
        new HeadObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      return { sizeBytes: result.ContentLength ?? 0, contentType: result.ContentType };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    let result;
    try {
      result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
    if ((result.ContentLength ?? 0) > maxBytes) throw new ObjectTooLargeError();
    const bytes = await result.Body?.transformToByteArray();
    if (bytes === undefined) return Buffer.alloc(0);
    if (bytes.length > maxBytes) throw new ObjectTooLargeError();
    return Buffer.from(bytes);
  }

  async write(key: string, body: Buffer, contentType: string): Promise<void> {
    const { sse, sseKmsKeyId } = this.config.storage;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
        ContentLength: body.length,
        CacheControl: 'private, no-store, max-age=0',
        ...(sse === 'none' ? {} : { ServerSideEncryption: sse }),
        ...(sse === 'aws:kms' && sseKmsKeyId !== undefined ? { SSEKMSKeyId: sseKmsKeyId } : {}),
      }),
    );
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  onModuleDestroy(): void {
    this.client.destroy();
    this.presigner.destroy();
  }
}
