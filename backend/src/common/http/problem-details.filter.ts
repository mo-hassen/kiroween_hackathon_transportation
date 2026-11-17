import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  codeForStatus,
  DomainError,
  ErrorCode,
  type FieldError,
  type ProblemDetails,
  problemType,
  titleFor,
} from './problem-details.js';

interface Classified {
  readonly status: number;
  readonly code: string;
  readonly title: string;
  readonly errors: readonly FieldError[];
  readonly unexpected: boolean;
  readonly headers?: Readonly<Record<string, string>>;
}

/** Errors raised by Express middleware (body-parser) carry a status and a `type`. */
function middlewareStatus(exception: unknown): number | undefined {
  if (typeof exception !== 'object' || exception === null) return undefined;
  const candidate = exception as { status?: unknown; statusCode?: unknown; type?: unknown };
  const status = candidate.status ?? candidate.statusCode;
  if (
    typeof candidate.type === 'string' &&
    typeof status === 'number' &&
    status >= 400 &&
    status < 500
  ) {
    return status;
  }
  return undefined;
}

export function classifyException(exception: unknown): Classified {
  if (exception instanceof DomainError) {
    const known = Object.values(ErrorCode).includes(exception.code as ErrorCode);
    return {
      status: exception.status,
      code: exception.code,
      title:
        exception.title ??
        (known ? titleFor(exception.code as ErrorCode) : titleFor(codeForStatus(exception.status))),
      errors: exception.fieldErrors,
      unexpected: false,
      ...(Object.keys(exception.headers).length > 0 ? { headers: exception.headers } : {}),
    };
  }
  const status =
    exception instanceof HttpException ? exception.getStatus() : middlewareStatus(exception);
  if (status !== undefined && status < 500) {
    const code = codeForStatus(status);
    return { status, code, title: titleFor(code), errors: [], unexpected: false };
  }
  const code = status === 503 ? ErrorCode.SERVICE_UNAVAILABLE : ErrorCode.INTERNAL_ERROR;
  return { status: status ?? 500, code, title: titleFor(code), errors: [], unexpected: true };
}

/**
 * Converts every error into an RFC 9457 problem-details response. Internal details
 * (messages, stack traces, SQL, provider responses) are logged, never returned.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger('ProblemDetailsFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request & { id?: unknown }>();
    const response = http.getResponse<Response>();
    const requestId = typeof request.id === 'string' ? request.id : undefined;
    const classified = classifyException(exception);

    if (classified.unexpected) {
      this.logger.error(
        { err: exception, requestId, method: request.method, path: request.path },
        'Unhandled exception',
      );
    }

    const body: ProblemDetails = {
      type: problemType(classified.code),
      title: classified.title,
      status: classified.status,
      code: classified.code,
      requestId,
      ...(classified.errors.length > 0 ? { errors: classified.errors } : {}),
    };

    if (response.headersSent) {
      return;
    }
    for (const [name, value] of Object.entries(classified.headers ?? {})) {
      response.setHeader(name, value);
    }
    response.status(classified.status).type('application/problem+json').send(JSON.stringify(body));
  }
}
