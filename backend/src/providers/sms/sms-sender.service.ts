import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { DomainError, ErrorCode } from '../../common/http/problem-details.js';
import type { Locale } from '../../generated/prisma/client.js';
import { maskPhone, SmsProvider } from './sms-provider.js';
import { renderSms, type SmsTemplate } from './sms-templates.js';

/**
 * Sends SMS without delaying the HTTP response. OTP endpoints must respond identically
 * whether or not a message is sent (account enumeration), so delivery runs in the
 * background and failures are logged (number masked) instead of returned.
 */
@Injectable()
export class SmsSender {
  private readonly logger = new Logger('SmsSender');

  constructor(private readonly provider: SmsProvider) {}

  /** Throws 503 SMS_UNAVAILABLE for every caller alike when no provider is configured. */
  assertAvailable(): void {
    if (!this.provider.available) {
      throw new DomainError(ErrorCode.SMS_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
    }
  }

  sendInBackground(to: string, template: SmsTemplate, locale: Locale, code?: string): void {
    this.provider
      .send({ to, template, text: renderSms(template, locale, code) })
      .catch((error: unknown) => {
        this.logger.error(
          {
            to: maskPhone(to),
            template,
            err: error instanceof Error ? { name: error.name } : undefined,
          },
          'SMS delivery failed',
        );
      });
  }
}
