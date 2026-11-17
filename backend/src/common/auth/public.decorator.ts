import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:is-public';

/**
 * Marks a route as reachable without authentication. Every use must also be added to
 * the allow-list in test/e2e/public-routes.e2e.spec.ts, which fails otherwise.
 */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC, true);
