import { Writable } from 'node:stream';
import { pino } from 'pino';
import { buildPinoHttpOptions, pathWithoutQuery, REDACTED } from './logger.options.js';

function captureLogger(): { logger: pino.Logger; lines: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  const { redact, level } = buildPinoHttpOptions('info');
  return { logger: pino({ redact, level: level ?? 'info' }, stream), lines: () => chunks.join('') };
}

describe('log redaction', () => {
  it.each([
    'password',
    'refreshToken',
    'accessToken',
    'otp',
    'authorization',
    'licenseNumber',
    'tin',
    'accountRef',
    'clientSecret',
  ])('redacts "%s" at top level and one level deep', (key) => {
    const { logger, lines } = captureLogger();
    const secret = `value-of-${key}-123456`;
    logger.info({ [key]: secret, nested: { [key]: secret } }, 'event');
    const output = lines();
    expect(output).not.toContain(secret);
    expect(output).toContain(REDACTED);
  });

  it('keeps non-sensitive fields', () => {
    const { logger, lines } = captureLogger();
    logger.info({ userId: 'u-1', route: '/x' }, 'event');
    expect(lines()).toContain('u-1');
  });
});

describe('pathWithoutQuery', () => {
  it('drops the query string', () => {
    expect(pathWithoutQuery('/api/v1/identity/callback?code=abc&state=xyz')).toBe(
      '/api/v1/identity/callback',
    );
    expect(pathWithoutQuery('/api/v1/health/live')).toBe('/api/v1/health/live');
    expect(pathWithoutQuery(undefined)).toBe('');
  });
});
