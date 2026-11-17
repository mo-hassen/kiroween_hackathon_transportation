import { Logger } from '@nestjs/common';
import { maskPhone, type SmsMessage, SmsProvider, SmsUnavailableError } from './sms-provider.js';

export interface StoredSms {
  readonly to: string;
  readonly template: string;
  readonly text: string;
  readonly sentAt: string;
}

const PER_PHONE = 20;
const TOTAL = 1000;

/**
 * DEVELOPMENT/TEST ONLY. Keeps sent messages in process memory so developers and tests
 * can read codes through the dev inbox endpoint. Logs a masked number and the template
 * id only, never the message text. Config validation rejects it outside development/test.
 */
export class DevSmsProvider extends SmsProvider {
  readonly id = 'dev';
  readonly available = true;
  private readonly logger = new Logger('DevSms');
  private readonly inbox = new Map<string, StoredSms[]>();
  private total = 0;

  send(message: SmsMessage): Promise<void> {
    const messages = this.inbox.get(message.to) ?? [];
    messages.unshift({ ...message, sentAt: new Date().toISOString() });
    if (messages.length > PER_PHONE) messages.length = PER_PHONE;
    this.inbox.set(message.to, messages);
    this.total += 1;
    if (this.total > TOTAL) {
      this.inbox.clear();
      this.total = 0;
    }
    this.logger.log({ to: maskPhone(message.to), template: message.template }, 'Dev SMS stored');
    return Promise.resolve();
  }

  /** Newest first. */
  messagesFor(phone: string): readonly StoredSms[] {
    return this.inbox.get(phone) ?? [];
  }
}

/** Default outside development: no provider is integrated, so SMS features fail closed. */
export class DisabledSmsProvider extends SmsProvider {
  readonly id = 'disabled';
  readonly available = false;

  send(): Promise<void> {
    return Promise.reject(new SmsUnavailableError());
  }
}
