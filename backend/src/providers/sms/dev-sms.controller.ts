import { Controller, Get, HttpStatus, Inject, Query } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { Public } from '../../common/auth/public.decorator.js';
import { DomainError, ErrorCode, validationError } from '../../common/http/problem-details.js';
import { normalizeEthiopianMobile } from '../../common/validation/ethiopian-phone.js';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { DevSmsProvider, type StoredSms } from './dev-sms.provider.js';
import { SmsProvider } from './sms-provider.js';

/**
 * DEVELOPMENT/TEST ONLY: read the in-memory SMS inbox (including codes). The module is
 * only mounted when SMS_PROVIDER=dev, which config validation forbids outside
 * development/test; the handler re-checks both conditions anyway.
 */
@ApiExcludeController()
@Public()
@SkipThrottle()
@Controller({ path: 'dev/sms', version: '1' })
export class DevSmsController {
  constructor(
    private readonly provider: SmsProvider,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get('messages')
  messages(@Query('phone') phone: string | undefined): readonly StoredSms[] {
    if (!(this.provider instanceof DevSmsProvider) || this.config.isDeployed) {
      throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
    }
    const normalized = typeof phone === 'string' ? normalizeEthiopianMobile(phone) : null;
    if (normalized === null) throw validationError('phone', 'IS_ETHIOPIAN_MOBILE');
    return this.provider.messagesFor(normalized);
  }
}
