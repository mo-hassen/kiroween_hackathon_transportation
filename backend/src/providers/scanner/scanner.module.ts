import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { ClamAvScanner, DevFileScanner, DisabledFileScanner, FileScanner } from './file-scanner.js';

/** The dev scanner is never built in a deployed environment; misconfiguration fails closed. */
export function createFileScanner(config: AppConfig): FileScanner {
  const { scanner, clamav } = config.documents;
  if (scanner === 'clamav' && clamav !== undefined) {
    return new ClamAvScanner(clamav.host, clamav.port, clamav.timeoutMs);
  }
  if (scanner === 'dev' && !config.isDeployed) return new DevFileScanner();
  return new DisabledFileScanner();
}

@Global()
@Module({})
export class ScannerModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: ScannerModule,
      providers: [{ provide: FileScanner, useValue: createFileScanner(config) }],
      exports: [FileScanner],
    };
  }
}
