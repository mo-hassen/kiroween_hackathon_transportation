import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { REQUEST_ID_HEADER, resolveRequestId } from '../http/request-id.js';

export const REDACTED = '[REDACTED]';

/**
 * Field names that must never reach logs (docs/architecture/07-security-architecture.md).
 * pino wildcards match one level, so each sensitive key is listed at top level and one
 * level deep. Request/response headers are not serialized at all (see serializers).
 */
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'otp',
  'accessToken',
  'refreshToken',
  'idToken',
  'token',
  'authorization',
  'cookie',
  'secret',
  'clientSecret',
  'privateKey',
  'mfaSecret',
  'apiKey',
  'licenseNumber',
  'tin',
  'nationalId',
  'accountRef',
  // Phase 4: identity provider session values and claims.
  'codeVerifier',
  'nonce',
  'state',
  'clientAssertion',
  'fullName',
  'dateOfBirth',
] as const;

export const REDACT_PATHS: readonly string[] = SENSITIVE_KEYS.flatMap((key) => [key, `*.${key}`]);

/** Logs the path only: query strings can carry OAuth codes, state values or PII. */
export function pathWithoutQuery(url: string | undefined): string {
  if (url === undefined) return '';
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

const QUIET_PATHS = new Set(['/api/v1/health/live', '/api/v1/health/ready']);

interface SerializedRequest {
  id?: unknown;
  method?: string;
  url?: string;
}

export function buildPinoHttpOptions(level: string): Options {
  return {
    level,
    redact: { paths: [...REDACT_PATHS], censor: REDACTED },
    genReqId: (req: IncomingMessage, res: ServerResponse) => {
      const id = resolveRequestId(req.headers[REQUEST_ID_HEADER.toLowerCase()]);
      res.setHeader(REQUEST_ID_HEADER, id);
      return id;
    },
    serializers: {
      req: (req: SerializedRequest) => ({
        id: req.id,
        method: req.method,
        path: pathWithoutQuery(req.url),
      }),
      res: (res: { statusCode?: number }) => ({ statusCode: res.statusCode }),
    },
    customLogLevel: (_req, res, err) => {
      if (err !== undefined || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    autoLogging: { ignore: (req) => QUIET_PATHS.has(pathWithoutQuery(req.url)) },
  };
}

export type PinoHttpParams = Options | [Options, DestinationStream];

export function buildPinoHttpParams(
  level: string,
  destination?: DestinationStream,
): PinoHttpParams {
  const options = buildPinoHttpOptions(level);
  return destination === undefined ? options : [options, destination];
}
