import { type DynamicModule, Global, Logger, Module } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { DevIdentityController } from './dev-identity.controller.js';
import { DevIdentityProvider } from './dev-identity.provider.js';
import { EsignetIdentityProvider } from './esignet-identity.provider.js';
import {
  DisabledIdentityProvider,
  IdentityProvider,
  identityCallbackUrl,
} from './identity-provider.js';

/** Builds the configured adapter. The dev adapter is never built in a deployed environment. */
export function createIdentityProvider(config: AppConfig): IdentityProvider {
  const { identity } = config;
  if (identity.provider === 'dev' && !config.isDeployed) {
    return new DevIdentityProvider(
      identity.publicApiBaseUrl,
      identityCallbackUrl(identity.publicApiBaseUrl, 'dev'),
    );
  }
  if (identity.provider === 'esignet' && identity.esignet !== undefined) {
    return new EsignetIdentityProvider(identity.esignet);
  }
  if (identity.provider !== 'disabled') {
    // Unreachable with validated config; fail closed rather than fall back to dev.
    new Logger('IdentityProvider').error('Identity provider misconfigured; verification disabled');
  }
  return new DisabledIdentityProvider();
}

/** Binds IdentityProvider. The dev consent page exists only with the dev adapter. */
@Global()
@Module({})
export class IdentityProviderModule {
  static forRoot(config: AppConfig): DynamicModule {
    const provider = createIdentityProvider(config);
    return {
      module: IdentityProviderModule,
      controllers: provider instanceof DevIdentityProvider ? [DevIdentityController] : [],
      providers: [{ provide: IdentityProvider, useValue: provider }],
      exports: [IdentityProvider],
    };
  }
}
