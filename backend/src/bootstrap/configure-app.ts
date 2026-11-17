import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { Logger } from 'nestjs-pino';
import { REQUEST_ID_HEADER } from '../common/http/request-id.js';
import type { AppConfig } from '../config/app-config.js';

export const API_PREFIX = 'api';
export const API_DOCS_PATH = 'api/docs';
export const JSON_BODY_LIMIT = '1mb';

/**
 * Applies HTTP-level security and conventions. Used by main.api.ts and by every e2e test,
 * so tests exercise the same pipeline as production.
 */
export function configureApp(app: NestExpressApplication, config: AppConfig): void {
  app.useLogger(app.get(Logger));
  app.disable('x-powered-by');
  if (config.http.trustProxyHops > 0) {
    app.set('trust proxy', config.http.trustProxyHops);
  }

  app.use(
    helmet({
      // HSTS only where TLS is guaranteed (staging/production behind the TLS proxy).
      strictTransportSecurity: config.isDeployed
        ? { maxAge: 31_536_000, includeSubDomains: true }
        : false,
      crossOriginResourcePolicy: { policy: 'same-site' },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );

  // API responses can carry tokens and personal data: never store them in caches.
  app.use(
    (
      _request: unknown,
      response: { setHeader(name: string, value: string): void },
      next: () => void,
    ) => {
      response.setHeader('Cache-Control', 'no-store');
      next();
    },
  );

  // JSON only; no urlencoded/multipart parsing (uploads go directly to object storage).
  app.useBodyParser('json', { limit: JSON_BODY_LIMIT, strict: true });

  const allowed = new Set(config.cors.allowedOrigins);
  app.enableCors({
    // Requests without an Origin (mobile apps, server-to-server) are not CORS requests.
    origin: (origin, callback) => {
      callback(null, origin !== undefined && allowed.has(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: [
      'Authorization',
      'Content-Type',
      'Idempotency-Key',
      'If-Match',
      REQUEST_ID_HEADER,
    ],
    exposedHeaders: [REQUEST_ID_HEADER, 'Retry-After'],
    credentials: false,
    maxAge: 600,
  });

  app.setGlobalPrefix(API_PREFIX);
  app.enableVersioning({ type: VersioningType.URI });

  if (config.apiDocsEnabled) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('Kiroween Mobility API')
        .setDescription(
          'Addis Ababa owner/driver vehicle platform. Errors use RFC 9457 problem details.',
        )
        .setVersion('1')
        .addBearerAuth()
        .build(),
    );
    SwaggerModule.setup(API_DOCS_PATH, app, document, {
      jsonDocumentUrl: `${API_DOCS_PATH}/openapi.json`,
    });
  }

  app.enableShutdownHooks();
}
