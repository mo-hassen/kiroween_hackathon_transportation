import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { AppConfig } from '../../config/app-config.js';
import { DevSmsController } from './dev-sms.controller.js';
import { DevSmsProvider, DisabledSmsProvider } from './dev-sms.provider.js';
import { SmsProvider } from './sms-provider.js';
import { SmsSender } from './sms-sender.service.js';

/** Binds the configured SMS adapter. The dev inbox route exists only with the dev adapter. */
@Global()
@Module({})
export class SmsModule {
  static forRoot(config: AppConfig): DynamicModule {
    const useDev = config.sms.provider === 'dev' && !config.isDeployed;
    return {
      module: SmsModule,
      controllers: useDev ? [DevSmsController] : [],
      providers: [
        {
          provide: SmsProvider,
          useValue: useDev ? new DevSmsProvider() : new DisabledSmsProvider(),
        },
        SmsSender,
      ],
      exports: [SmsProvider, SmsSender],
    };
  }
}
