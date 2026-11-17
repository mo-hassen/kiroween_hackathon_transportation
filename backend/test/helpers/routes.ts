import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, Reflector } from '@nestjs/core';
import { IS_PUBLIC } from '../../src/common/auth/public.decorator.js';
import type { TestApp } from './test-app.js';

export interface RouteInfo {
  /** e.g. `GET me/sessions` (no /api/v1 prefix). */
  readonly route: string;
  readonly isPublic: boolean;
}

/** Every controller route of the running app, with its @Public() flag. Needs DiscoveryModule. */
export function collectRoutes(testApp: TestApp): RouteInfo[] {
  const discovery = testApp.app.get(DiscoveryService);
  const reflector = testApp.app.get(Reflector);
  return discovery.getControllers().flatMap((wrapper) => {
    const controller = wrapper.metatype;
    if (typeof controller !== 'function') return [];
    const prototype = controller.prototype as Record<string, unknown>;
    const basePath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    return Object.getOwnPropertyNames(prototype)
      .filter((name) => name !== 'constructor' && typeof prototype[name] === 'function')
      .flatMap((name) => {
        const handler = prototype[name] as () => unknown;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
        if (method === undefined) return [];
        const path = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
        const isPublic =
          reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [handler, controller]) ===
          true;
        const fullPath = [basePath, path]
          .map((segment) => segment.replace(/^\/+|\/+$/g, ''))
          .filter(Boolean)
          .join('/');
        return [{ route: `${RequestMethod[method]} ${fullPath}`, isPublic }];
      });
  });
}
