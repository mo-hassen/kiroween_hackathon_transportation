import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';

/** Request facts recorded in audit logs and sessions. */
export interface RequestMeta {
  readonly requestId: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
}

const MAX_USER_AGENT = 512;

export function requestMetaFrom(request: Request & { id?: unknown }): RequestMeta {
  const userAgent = request.headers['user-agent'];
  return {
    requestId: typeof request.id === 'string' ? request.id : undefined,
    // Honours TRUST_PROXY_HOPS; normalises IPv4-mapped IPv6 addresses.
    ip: request.ip?.replace(/^::ffff:/, ''),
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, MAX_USER_AGENT) : undefined,
  };
}

export const ReqMeta = createParamDecorator(
  (_data: unknown, context: ExecutionContext): RequestMeta =>
    requestMetaFrom(context.switchToHttp().getRequest<Request & { id?: unknown }>()),
);
