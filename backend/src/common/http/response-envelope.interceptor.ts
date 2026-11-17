import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { map, type Observable } from 'rxjs';

const RAW_RESPONSE = 'http:raw-response';

/** Opt a handler out of the `{ data }` envelope (e.g. redirects, provider webhooks). */
export const RawResponse = (): MethodDecorator & ClassDecorator => SetMetadata(RAW_RESPONSE, true);

/** Wraps successful responses as `{ "data": ... }` (docs/architecture/04-api-architecture.md). */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const raw = this.reflector.getAllAndOverride<boolean | undefined>(RAW_RESPONSE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (raw === true) {
      return next.handle();
    }
    return next.handle().pipe(map((data: unknown) => (data === undefined ? undefined : { data })));
  }
}
