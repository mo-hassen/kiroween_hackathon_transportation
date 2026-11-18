import { readFileSync } from 'node:fs';
import type { IdentityStatus, IdentityVerificationStatus } from '../../generated/prisma/client.js';
import {
  ACCOUNT_TRANSITIONS,
  accountStatusAfter,
  addMonths,
  ATTEMPT_TRANSITIONS,
  canStart,
  canTransitionAccount,
  canTransitionAttempt,
  clientReason,
  OutcomeCode,
} from './identity-state.js';

const ATTEMPT_STATUSES = Object.keys(ATTEMPT_TRANSITIONS) as IdentityVerificationStatus[];
const ACCOUNT_STATUSES = Object.keys(ACCOUNT_TRANSITIONS) as IdentityStatus[];

/** Reads the `(OLD."col" = 'X' AND NEW."col" IN (...))` pairs from the migration trigger. */
function sqlTransitions(column: string): Map<string, Set<string>> {
  const sql = readFileSync('prisma/migrations/20261117180000_identity/migration.sql', 'utf8');
  const pattern = new RegExp(
    String.raw`\(OLD\."${column}" = '(\w+)' AND NEW\."${column}" (?:IN \(([^)]*)\)|= '(\w+)')\)`,
    'g',
  );
  const table = new Map<string, Set<string>>();
  for (const match of sql.matchAll(pattern)) {
    const targets = match[2] ?? `'${match[3] ?? ''}'`;
    const set = table.get(match[1] ?? '') ?? new Set<string>();
    for (const target of targets.matchAll(/'(\w+)'/g)) set.add(target[1] ?? '');
    table.set(match[1] ?? '', set);
  }
  return table;
}

function asSets(table: Readonly<Record<string, readonly string[]>>): Map<string, Set<string>> {
  return new Map(
    Object.entries(table)
      .filter(([, targets]) => targets.length > 0)
      .map(([from, targets]) => [from, new Set(targets)]),
  );
}

describe('identity state machines', () => {
  it('the database triggers enforce exactly the code transition tables', () => {
    expect(sqlTransitions('status')).toEqual(asSets(ATTEMPT_TRANSITIONS));
    expect(sqlTransitions('identity_status')).toEqual(asSets(ACCOUNT_TRANSITIONS));
  });

  it('allows exactly the documented attempt transitions (every pair checked)', () => {
    const allowed = new Set([
      'PENDING>VERIFIED',
      'PENDING>REJECTED',
      'PENDING>FAILED',
      'PENDING>EXPIRED',
      'PENDING>CANCELLED',
      'PENDING>SUPERSEDED',
      'VERIFIED>EXPIRED',
      'VERIFIED>REVERIFICATION_REQUIRED',
      'VERIFIED>SUSPENDED',
      'REVERIFICATION_REQUIRED>SUSPENDED',
      'REVERIFICATION_REQUIRED>SUPERSEDED',
      'SUSPENDED>REVERIFICATION_REQUIRED',
    ]);
    for (const from of ATTEMPT_STATUSES) {
      for (const to of ATTEMPT_STATUSES) {
        expect({ pair: `${from}>${to}`, ok: canTransitionAttempt(from, to) }).toEqual({
          pair: `${from}>${to}`,
          ok: allowed.has(`${from}>${to}`),
        });
      }
    }
  });

  it('never lets an account become VERIFIED except from PENDING (no self-verification path)', () => {
    for (const from of ACCOUNT_STATUSES) {
      expect(canTransitionAccount(from, 'VERIFIED')).toBe(from === 'PENDING');
    }
  });

  it('makes REJECTED, FAILED, EXPIRED, CANCELLED and SUPERSEDED attempts terminal', () => {
    for (const status of ['REJECTED', 'FAILED', 'EXPIRED', 'CANCELLED', 'SUPERSEDED'] as const) {
      expect(ATTEMPT_TRANSITIONS[status]).toEqual([]);
    }
  });

  it('starts only from statuses that need a (new) verification', () => {
    expect(ACCOUNT_STATUSES.filter(canStart).sort()).toEqual(
      ['EXPIRED', 'PENDING', 'REJECTED', 'REVERIFICATION_REQUIRED', 'UNVERIFIED'].sort(),
    );
  });

  it('keeps results and restores the previous status for non-results', () => {
    for (const previous of [
      'UNVERIFIED',
      'REJECTED',
      'EXPIRED',
      'REVERIFICATION_REQUIRED',
    ] as const) {
      expect(accountStatusAfter('VERIFIED', previous)).toBe('VERIFIED');
      expect(accountStatusAfter('REJECTED', previous)).toBe('REJECTED');
      for (const outcome of ['FAILED', 'EXPIRED', 'CANCELLED'] as const) {
        const next = accountStatusAfter(outcome, previous);
        expect(next).toBe(previous);
        expect(canTransitionAccount('PENDING', next)).toBe(true);
      }
    }
  });

  it('shows the same reason for every rejection (no hint that an identity is registered)', () => {
    for (const code of [
      OutcomeCode.IDENTITY_ALREADY_LINKED,
      OutcomeCode.IDENTITY_MISMATCH,
      OutcomeCode.ASSURANCE_TOO_LOW,
    ]) {
      expect(clientReason('REJECTED', code)).toBe('VERIFICATION_REJECTED');
    }
  });

  it('maps outcomes to coarse client reasons', () => {
    expect(clientReason('FAILED', OutcomeCode.PROVIDER_TIMEOUT)).toBe('PROVIDER_UNAVAILABLE');
    expect(clientReason('FAILED', OutcomeCode.PROVIDER_UNAVAILABLE)).toBe('PROVIDER_UNAVAILABLE');
    expect(clientReason('FAILED', OutcomeCode.INVALID_RESPONSE)).toBe('VERIFICATION_FAILED');
    expect(clientReason('FAILED', OutcomeCode.INVALID_GRANT)).toBe('VERIFICATION_FAILED');
    expect(clientReason('EXPIRED', OutcomeCode.SESSION_EXPIRED)).toBe('SESSION_EXPIRED');
    expect(clientReason('EXPIRED', OutcomeCode.VALIDITY_ENDED)).toBe('VALIDITY_ENDED');
    expect(clientReason('CANCELLED', OutcomeCode.CANCELLED_BY_USER)).toBe('CANCELLED');
    expect(clientReason('CANCELLED', OutcomeCode.DECLINED_AT_PROVIDER)).toBe(
      'DECLINED_AT_PROVIDER',
    );
    expect(clientReason('CANCELLED', OutcomeCode.CLOSED_BY_STAFF)).toBe('CLOSED_BY_SUPPORT');
    expect(clientReason('SUPERSEDED', OutcomeCode.REPLACED_BY_NEW_ATTEMPT)).toBe('REPLACED');
    for (const status of ['PENDING', 'VERIFIED', 'SUSPENDED', 'REVERIFICATION_REQUIRED'] as const) {
      expect(clientReason(status, null)).toBeNull();
    }
  });

  it.each([
    ['2026-11-17T10:00:00.000Z', 24, '2028-11-17T10:00:00.000Z'],
    ['2026-01-31T00:00:00.000Z', 1, '2026-02-28T00:00:00.000Z'],
    ['2028-02-29T12:00:00.000Z', 12, '2029-02-28T12:00:00.000Z'],
    ['2026-12-15T00:00:00.000Z', 3, '2027-03-15T00:00:00.000Z'],
  ])('addMonths(%s, %i) = %s', (from, months, expected) => {
    expect(addMonths(new Date(from), months).toISOString()).toBe(expected);
  });
});
