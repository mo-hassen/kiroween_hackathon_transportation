/**
 * External SMS integration boundary [EXTERNAL] (docs/architecture/05-backend-architecture.md).
 *
 * Implemented adapters: `dev` (in-memory inbox, development/test only) and `disabled`
 * (fails closed; the default outside development). A real Ethiopian SMS gateway adapter
 * must be written from the provider's official documentation and tested against its
 * sandbox before it is added here.
 */
export interface SmsMessage {
  /** E.164 Ethiopian mobile number. */
  readonly to: string;
  /** Template id, for logs and metrics. Logs never contain `text`. */
  readonly template: string;
  readonly text: string;
}

export abstract class SmsProvider {
  abstract readonly id: string;
  /** False when no provider is configured; callers must fail closed before doing work. */
  abstract readonly available: boolean;
  abstract send(message: SmsMessage): Promise<void>;
}

export class SmsUnavailableError extends Error {
  constructor() {
    super('No SMS provider is configured');
    this.name = 'SmsUnavailableError';
  }
}

/** `+251911234567` -> `+2519******67`, for logs. */
export function maskPhone(e164: string): string {
  return e164.length < 8
    ? '***'
    : `${e164.slice(0, 5)}${'*'.repeat(e164.length - 7)}${e164.slice(-2)}`;
}
