import type { RateLimitRule } from '../../common/rate-limit/rate-limit.service.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Lifetimes and limits from docs/architecture/07-security-architecture.md and 04 §Rate limits. */
export const AUTH_POLICY = Object.freeze({
  otpTtlMs: 5 * MINUTE,
  otpMaxAttempts: 5,
  customerSessionTtlMs: 30 * DAY,
  staffSessionTtlMs: 12 * HOUR,
  /** A refresh retried after a lost response may reuse the previous token this long. */
  refreshRetryGraceMs: 2 * MINUTE,
  staffActivationTtlMs: 72 * HOUR,
  staffActivationMaxAttempts: 5,
  staffEnrollmentTtlMs: 15 * MINUTE,
  staffEnrollmentMaxAttempts: 5,
});

export const AUTH_RATE_LIMITS = Object.freeze({
  otpSendPerPhone: { name: 'otp-send-phone-15m', limit: 3, windowMs: 15 * MINUTE },
  otpSendPerPhoneDaily: { name: 'otp-send-phone-1d', limit: 10, windowMs: DAY },
  otpSendPerIp: { name: 'otp-send-ip-1h', limit: 20, windowMs: HOUR },
  loginPerPhone: { name: 'login-phone-15m', limit: 5, windowMs: 15 * MINUTE },
  loginPerIp: { name: 'login-ip-15m', limit: 30, windowMs: 15 * MINUTE },
  codeVerifyPerIp: { name: 'code-verify-ip-15m', limit: 30, windowMs: 15 * MINUTE },
  refreshPerIp: { name: 'refresh-ip-1m', limit: 60, windowMs: MINUTE },
  sensitivePerUser: { name: 'sensitive-user-15m', limit: 5, windowMs: 15 * MINUTE },
} satisfies Record<string, RateLimitRule>);
