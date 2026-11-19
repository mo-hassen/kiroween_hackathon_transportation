import { readFileSync } from 'node:fs';
import type { ReviewStatus } from '../../generated/prisma/client.js';
import {
  addisToday,
  canTransition,
  evaluateEligibility,
  type EligibilityFacts,
  normalizeCategories,
  normalizeLicenseNumber,
  parseIsoDate,
  REVIEW_TRANSITIONS,
  submissionProblems,
} from './driver-rules.js';

const STATUSES = Object.keys(REVIEW_TRANSITIONS) as ReviewStatus[];

function sqlTransitions(): Map<string, Set<string>> {
  const sql = readFileSync(
    'prisma/migrations/20261118150000_documents_drivers/migration.sql',
    'utf8',
  );
  const table = new Map<string, Set<string>>();
  const pattern =
    /\(OLD\."review_status" = '(\w+)' AND NEW\."review_status" (?:IN \(([^)]*)\)|= '(\w+)')\)/g;
  for (const match of sql.matchAll(pattern)) {
    const targets = match[2] ?? `'${match[3] ?? ''}'`;
    const set = table.get(match[1] ?? '') ?? new Set<string>();
    for (const target of targets.matchAll(/'(\w+)'/g)) set.add(target[1] ?? '');
    table.set(match[1] ?? '', set);
  }
  return table;
}

const approvedDocs = [
  { purpose: 'DRIVER_LICENSE_FRONT', uploadStatus: 'AVAILABLE', reviewStatus: 'APPROVED' },
  { purpose: 'DRIVER_LICENSE_BACK', uploadStatus: 'AVAILABLE', reviewStatus: 'APPROVED' },
] as const;

const eligible: EligibilityFacts = {
  accountStatus: 'ACTIVE',
  identityStatus: 'VERIFIED',
  suspended: false,
  license: { reviewStatus: 'APPROVED', expiresOn: '2030-01-01', documents: approvedDocs },
};

describe('driver review state machine', () => {
  it('the database trigger enforces exactly the code transition table', () => {
    const fromCode = new Map(
      Object.entries(REVIEW_TRANSITIONS).map(([from, to]) => [from, new Set<string>(to)]),
    );
    expect(sqlTransitions()).toEqual(fromCode);
  });

  it('allows exactly the documented transitions (every pair)', () => {
    const allowed = new Set([
      'DRAFT>SUBMITTED',
      'SUBMITTED>UNDER_REVIEW',
      'UNDER_REVIEW>SUBMITTED',
      'UNDER_REVIEW>UNDER_REVIEW',
      'UNDER_REVIEW>APPROVED',
      'UNDER_REVIEW>REJECTED',
      'REJECTED>DRAFT',
      'APPROVED>EXPIRED',
      'APPROVED>SUSPENDED',
      'SUSPENDED>APPROVED',
      'SUSPENDED>EXPIRED',
      'EXPIRED>DRAFT',
    ]);
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect({ pair: `${from}>${to}`, ok: canTransition(from, to) }).toEqual({
          pair: `${from}>${to}`,
          ok: allowed.has(`${from}>${to}`),
        });
      }
    }
  });

  it('only reaches APPROVED through review (or reinstatement of an approved driver)', () => {
    expect(STATUSES.filter((from) => canTransition(from, 'APPROVED')).sort()).toEqual([
      'SUSPENDED',
      'UNDER_REVIEW',
    ]);
  });
});

describe('driver eligibility (02 §3.5)', () => {
  it('is ELIGIBLE only when every condition holds', () => {
    expect(evaluateEligibility(eligible, '2026-11-18')).toEqual({
      status: 'ELIGIBLE',
      blockers: [],
    });
  });

  it.each<[string, Partial<EligibilityFacts>, string]>([
    ['account suspended', { accountStatus: 'SUSPENDED' }, 'ACCOUNT_NOT_ACTIVE'],
    ['identity pending', { identityStatus: 'PENDING' }, 'IDENTITY_NOT_VERIFIED'],
    ['identity expired', { identityStatus: 'EXPIRED' }, 'IDENTITY_NOT_VERIFIED'],
    ['no licence', { license: null }, 'LICENSE_MISSING'],
    [
      'licence submitted only',
      { license: { ...eligible.license!, reviewStatus: 'SUBMITTED' } },
      'LICENSE_NOT_APPROVED',
    ],
    [
      'licence expired',
      { license: { ...eligible.license!, expiresOn: '2026-11-18' } },
      'LICENSE_EXPIRED',
    ],
    [
      'back document missing',
      { license: { ...eligible.license!, documents: [approvedDocs[0]] } },
      'DOCUMENTS_NOT_APPROVED',
    ],
    [
      'document not approved',
      {
        license: {
          ...eligible.license!,
          documents: [approvedDocs[0], { ...approvedDocs[1], reviewStatus: 'SUBMITTED' }],
        },
      },
      'DOCUMENTS_NOT_APPROVED',
    ],
  ])('%s -> INELIGIBLE (%s)', (_label, change, blocker) => {
    const result = evaluateEligibility({ ...eligible, ...change }, '2026-11-18');
    expect(result.status).toBe('INELIGIBLE');
    expect(result.blockers).toContain(blocker);
  });

  it('a suspended driver is SUSPENDED even if everything else holds', () => {
    expect(evaluateEligibility({ ...eligible, suspended: true }, '2026-11-18')).toEqual({
      status: 'SUSPENDED',
      blockers: ['DRIVER_SUSPENDED'],
    });
  });
});

describe('submission checks', () => {
  const draftDocs = approvedDocs.map((d) => ({ ...d, reviewStatus: 'DRAFT' as const }));
  const facts = {
    accountStatus: 'ACTIVE' as const,
    identityStatus: 'VERIFIED' as const,
    issuedOn: '2022-01-01',
    expiresOn: '2030-01-01',
    documents: draftDocs,
  };

  it('accepts a complete request', () => {
    expect(submissionProblems(facts, '2026-11-18')).toEqual([]);
  });

  it('lists every problem', () => {
    expect(
      submissionProblems(
        {
          ...facts,
          identityStatus: 'UNVERIFIED',
          expiresOn: '2026-11-18',
          documents: [{ ...approvedDocs[0], reviewStatus: 'REJECTED' }],
        },
        '2026-11-18',
      ),
    ).toEqual([
      'IDENTITY_NOT_VERIFIED',
      'LICENSE_EXPIRED',
      'FRONT_DOCUMENT_MISSING',
      'BACK_DOCUMENT_MISSING',
    ]);
    expect(submissionProblems({ ...facts, issuedOn: '2026-12-01' }, '2026-11-18')).toEqual([
      'LICENSE_NOT_YET_ISSUED',
    ]);
  });
});

describe('normalization', () => {
  it.each([
    ['ab-123 456', 'AB123456'],
    ['A1/2.3 4', 'A1234'],
    ['abc', null],
    ['x'.repeat(21), null],
    ['AB_1234', null],
  ])('licence number %s -> %s', (input, expected) => {
    expect(normalizeLicenseNumber(input)).toBe(expected);
  });

  it('keeps category codes as given (no official list assumed) and rejects bad input', () => {
    expect(normalizeCategories([' b ', 'c1'])).toEqual(['B', 'C1']);
    expect(normalizeCategories([])).toBeNull();
    expect(normalizeCategories(['B', 'b'])).toBeNull();
    expect(normalizeCategories(['<script>'])).toBeNull();
    expect(normalizeCategories(Array.from({ length: 11 }, (_, i) => `C${i}`))).toBeNull();
  });

  it('parses only real calendar dates', () => {
    expect(parseIsoDate('2028-02-29')?.toISOString()).toBe('2028-02-29T00:00:00.000Z');
    expect(parseIsoDate('2027-02-29')).toBeNull();
    expect(parseIsoDate('29/02/2028')).toBeNull();
  });

  it('uses the Addis Ababa calendar date (UTC+3)', () => {
    expect(addisToday(new Date('2026-11-18T20:59:59Z'))).toBe('2026-11-18');
    expect(addisToday(new Date('2026-11-18T21:00:00Z'))).toBe('2026-11-19');
  });
});
