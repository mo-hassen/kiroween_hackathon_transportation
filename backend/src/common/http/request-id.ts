import { randomUUID } from 'node:crypto';

export const REQUEST_ID_HEADER = 'X-Request-Id';
const ACCEPTED_REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Accepts a client-supplied request ID only if it is short and contains no characters
 * that could break log lines or headers; otherwise generates a new one.
 */
export function resolveRequestId(header: string | string[] | undefined): string {
  const candidate = Array.isArray(header) ? header[0] : header;
  if (candidate !== undefined && ACCEPTED_REQUEST_ID.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}
