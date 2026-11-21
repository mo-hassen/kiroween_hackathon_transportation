import { readFileSync } from 'node:fs';
import type { OwnerVerificationStatus } from '../../generated/prisma/client.js';
import {
  approvalBlockers,
  approvalRefusal,
  canTransition,
  EDITABLE_STATUSES,
  maskTin,
  normalizeOrganizationName,
  normalizeTin,
  OWNER_TRANSITIONS,
  ownerBlockers,
  requiredDocuments,
  statusAfterIdentityCheck,
  submissionProblems,
  TYPE_CHANGE_STATUSES,
} from './owner-rules.js';

const STATUSES: OwnerVerificationStatus[] = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
];

const ORG_DOCS = [
  { purpose: 'OWNER_TIN', uploadStatus: 'AVAILABLE', reviewStatus: 'DRAFT' },
  { purpose: 'OWNER_BUSINESS_LICENSE', uploadStatus: 'AVAILABLE', reviewStatus: 'DRAFT' },
  { purpose: 'OWNER_REPRESENTATIVE_LETTER', uploadStatus: 'AVAILABLE', reviewStatus: 'DRAFT' },
] as const;

describe('owner verification transitions (02 §3.4)', () => {
  it('allows exactly the architecture state machine', () => {
    const allowed = STATUSES.flatMap((from) =>
      STATUSES.filter((to) => canTransition(from, to)).map((to) => `${from}->${to}`),
    );
    expect(allowed.sort()).toEqual(
      [
        'UNVERIFIED->PENDING',
        'PENDING->VERIFIED',
        'PENDING->REJECTED',
        'REJECTED->PENDING',
        'VERIFIED->SUSPENDED',
        'VERIFIED->EXPIRED',
        'VERIFIED->REVERIFICATION_REQUIRED',
        'SUSPENDED->VERIFIED',
        'SUSPENDED->REVERIFICATION_REQUIRED',
        'EXPIRED->PENDING',
        'REVERIFICATION_REQUIRED->PENDING',
      ].sort(),
    );
  });

  it('never lets an owner move straight to VERIFIED from a non-review state', () => {
    for (const from of STATUSES.filter((s) => s !== 'PENDING' && s !== 'SUSPENDED')) {
      expect(canTransition(from, 'VERIFIED')).toBe(false);
    }
  });

  it('matches the transition table in the migration trigger', () => {
    const sql = readFileSync(
      new URL(
        '../../../prisma/migrations/20261119090100_owner_verification/migration.sql',
        import.meta.url,
      ),
      'utf8',
    );
    const pairs = [
      ...sql.matchAll(
        /OLD\."verification_status" = '([A-Z_]+)' AND NEW\."verification_status" (?:= '([A-Z_]+)'|IN \(([^)]+)\))/g,
      ),
    ].flatMap(([, from, single, list]) =>
      (single !== undefined
        ? [single]
        : list!.split(',').map((v) => v.trim().replaceAll("'", ''))
      ).map((to) => `${from}->${to}`),
    );
    const code = Object.entries(OWNER_TRANSITIONS).flatMap(([from, tos]) =>
      tos.map((to) => `${from}->${to}`),
    );
    expect(pairs.sort()).toEqual(code.sort());
  });

  it('allows editing only outside review/verification and type changes only before verification', () => {
    expect([...EDITABLE_STATUSES].sort()).toEqual(
      ['EXPIRED', 'REJECTED', 'REVERIFICATION_REQUIRED', 'UNVERIFIED'].sort(),
    );
    expect([...TYPE_CHANGE_STATUSES].sort()).toEqual(['REJECTED', 'UNVERIFIED']);
  });
});

describe('TIN and organization name', () => {
  it('normalizes separators and case without inventing an official format', () => {
    expect(normalizeTin(' 0012-345.678/9 ')).toBe('0012345678' + '9');
    expect(normalizeTin('ab12cd')).toBe('AB12CD');
    expect(normalizeTin('123')).toBeNull();
    expect(normalizeTin('1'.repeat(21))).toBeNull();
    expect(normalizeTin('12#45')).toBeNull();
    expect(maskTin('6789')).toBe('••••6789');
  });

  it('trims organization names and refuses control characters', () => {
    expect(normalizeOrganizationName('  Abebe   Transport  PLC ')).toBe('Abebe Transport PLC');
    expect(normalizeOrganizationName('A')).toBeNull();
    expect(normalizeOrganizationName('x'.repeat(201))).toBeNull();
    expect(normalizeOrganizationName('Bad\u0000Name')).toBeNull();
    expect(normalizeOrganizationName('ሀበሻ ትራንስፖርት')).toBe('ሀበሻ ትራንስፖርት');
  });
});

describe('submission rules', () => {
  const base = {
    accountStatus: 'ACTIVE',
    identityStatus: 'VERIFIED',
    hasOrganizationDetails: true,
  } as const;

  it('individuals need an active account and a verified identity only', () => {
    expect(requiredDocuments('INDIVIDUAL')).toEqual([]);
    expect(submissionProblems({ ...base, ownerType: 'INDIVIDUAL', documents: [] })).toEqual([]);
    expect(
      submissionProblems({
        ...base,
        ownerType: 'INDIVIDUAL',
        accountStatus: 'SUSPENDED',
        identityStatus: 'EXPIRED',
        documents: [],
      }),
    ).toEqual(['ACCOUNT_NOT_ACTIVE', 'IDENTITY_NOT_VERIFIED']);
  });

  it('organizations need details and all three AVAILABLE, never-decided documents', () => {
    expect(submissionProblems({ ...base, ownerType: 'ORGANIZATION', documents: ORG_DOCS })).toEqual(
      [],
    );
    expect(
      submissionProblems({
        ...base,
        ownerType: 'ORGANIZATION',
        hasOrganizationDetails: false,
        documents: [],
      }),
    ).toEqual([
      'ORGANIZATION_DETAILS_MISSING',
      'TIN_DOCUMENT_MISSING',
      'BUSINESS_LICENSE_MISSING',
      'REPRESENTATIVE_LETTER_MISSING',
    ]);
    const decided = ORG_DOCS.map((d) =>
      d.purpose === 'OWNER_TIN' ? { ...d, reviewStatus: 'REJECTED' as const } : d,
    );
    expect(submissionProblems({ ...base, ownerType: 'ORGANIZATION', documents: decided })).toEqual([
      'TIN_DOCUMENT_MISSING',
    ]);
    const processing = ORG_DOCS.map((d) =>
      d.purpose === 'OWNER_BUSINESS_LICENSE' ? { ...d, uploadStatus: 'UPLOADED' as const } : d,
    );
    expect(
      submissionProblems({ ...base, ownerType: 'ORGANIZATION', documents: processing }),
    ).toEqual(['BUSINESS_LICENSE_MISSING']);
  });
});

describe('approval rules', () => {
  it('re-checks account, identity and documents at decision time', () => {
    const submitted = ORG_DOCS.map((d) => ({ ...d, reviewStatus: 'SUBMITTED' as const }));
    expect(
      approvalBlockers({
        accountStatus: 'ACTIVE',
        identityStatus: 'VERIFIED',
        ownerType: 'ORGANIZATION',
        documents: submitted,
      }),
    ).toEqual([]);
    expect(
      approvalBlockers({
        accountStatus: 'SUSPENDED',
        identityStatus: 'EXPIRED',
        ownerType: 'ORGANIZATION',
        documents: submitted.slice(1),
      }),
    ).toEqual(['ACCOUNT_NOT_ACTIVE', 'IDENTITY_NOT_VERIFIED', 'DOCUMENTS_MISSING']);
  });

  it('enforces four-eyes for organizations and a single approval for individuals', () => {
    const individual = { ownerType: 'INDIVIDUAL' as const, firstApprovedById: null };
    const fresh = { ownerType: 'ORGANIZATION' as const, firstApprovedById: null };
    const firstByA = { ownerType: 'ORGANIZATION' as const, firstApprovedById: 'A' };

    expect(approvalRefusal('APPROVE_INDIVIDUAL', individual, 'A')).toBeNull();
    expect(approvalRefusal('APPROVE_INDIVIDUAL', fresh, 'A')).toBe('WRONG_OWNER_TYPE');
    expect(approvalRefusal('FIRST_APPROVAL', individual, 'A')).toBe('WRONG_OWNER_TYPE');
    expect(approvalRefusal('SECOND_APPROVAL', individual, 'A')).toBe('WRONG_OWNER_TYPE');

    expect(approvalRefusal('FIRST_APPROVAL', fresh, 'A')).toBeNull();
    expect(approvalRefusal('FIRST_APPROVAL', firstByA, 'B')).toBe('ALREADY_FIRST_APPROVED');
    expect(approvalRefusal('SECOND_APPROVAL', fresh, 'B')).toBe('FIRST_APPROVAL_REQUIRED');
    expect(approvalRefusal('SECOND_APPROVAL', firstByA, 'A')).toBe('SAME_OFFICER');
    expect(approvalRefusal('SECOND_APPROVAL', firstByA, 'B')).toBeNull();
  });
});

describe('identity consequences and eligibility', () => {
  it('a verified owner loses verification with the identity', () => {
    expect(statusAfterIdentityCheck('VERIFIED', 'VERIFIED')).toBeNull();
    expect(statusAfterIdentityCheck('VERIFIED', 'EXPIRED')).toBe('EXPIRED');
    for (const identity of ['REVERIFICATION_REQUIRED', 'SUSPENDED', 'PENDING'] as const) {
      expect(statusAfterIdentityCheck('VERIFIED', identity)).toBe('REVERIFICATION_REQUIRED');
    }
    for (const status of STATUSES.filter((s) => s !== 'VERIFIED')) {
      expect(statusAfterIdentityCheck(status, 'EXPIRED')).toBeNull();
    }
  });

  it('only a verified owner with an active account and verified identity is eligible', () => {
    expect(
      ownerBlockers({ accountStatus: 'ACTIVE', identityStatus: 'VERIFIED', status: 'VERIFIED' }),
    ).toEqual([]);
    expect(
      ownerBlockers({ accountStatus: 'ACTIVE', identityStatus: 'VERIFIED', status: 'SUSPENDED' }),
    ).toEqual(['OWNER_SUSPENDED']);
    expect(
      ownerBlockers({ accountStatus: 'SUSPENDED', identityStatus: 'EXPIRED', status: 'PENDING' }),
    ).toEqual(['ACCOUNT_NOT_ACTIVE', 'IDENTITY_NOT_VERIFIED', 'OWNER_NOT_VERIFIED']);
  });
});
