import { describe, expect, it } from 'vitest';
import type { VehicleStatus } from '../../generated/prisma/client.js';
import {
  ARCHIVABLE_STATUSES,
  approvalBlockers,
  canTransition,
  EDITABLE_STATUSES,
  EVIDENCE_SLOTS,
  type EvidenceFacts,
  evidenceExpired,
  isMaterial,
  maskIdentifier,
  normalizeDisplayText,
  normalizeEngineNumber,
  normalizePlate,
  normalizeVin,
  type OwnerFacts,
  purposeOfSlot,
  REQUIRED_SLOTS,
  submissionProblems,
  validSeats,
  validYear,
  VEHICLE_STATUSES,
  VEHICLE_TRANSITIONS,
  vehicleEligibility,
} from './vehicle-rules.js';

const TODAY = '2026-11-20';
const OWNER: OwnerFacts = {
  accountStatus: 'ACTIVE',
  identityStatus: 'VERIFIED',
  ownerStatus: 'VERIFIED',
};
function evidence(
  overrides: Partial<Record<string, Partial<EvidenceFacts>>> = {},
): EvidenceFacts[] {
  return REQUIRED_SLOTS.map((slot) => ({
    slot,
    uploadStatus: 'AVAILABLE' as const,
    reviewStatus: 'DRAFT' as const,
    expiresOn: slot === 'INSURANCE' || slot === 'INSPECTION' ? '2027-06-01' : null,
    ...overrides[slot],
  }));
}

describe('status machine', () => {
  it('matches the architecture (02 §3.3)', () => {
    expect(VEHICLE_TRANSITIONS.DRAFT).toEqual(['SUBMITTED', 'ARCHIVED']);
    expect(VEHICLE_TRANSITIONS.UNDER_REVIEW).toEqual(['SUBMITTED', 'APPROVED', 'REJECTED']);
    expect(canTransition('APPROVED', 'SUSPENDED')).toBe(true);
    expect(canTransition('SUSPENDED', 'APPROVED')).toBe(true);
  });

  it('never goes from SUBMITTED straight to APPROVED, or out of ARCHIVED', () => {
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false);
    expect(canTransition('DRAFT', 'APPROVED')).toBe(false);
    for (const to of VEHICLE_STATUSES) expect(canTransition('ARCHIVED', to)).toBe(false);
  });

  it('only DRAFT, REJECTED and EXPIRED are editable; a suspended or reviewed vehicle is not archivable', () => {
    expect(EDITABLE_STATUSES).toEqual(['DRAFT', 'REJECTED', 'EXPIRED']);
    for (const status of ['SUBMITTED', 'UNDER_REVIEW', 'SUSPENDED'] as VehicleStatus[]) {
      expect(ARCHIVABLE_STATUSES).not.toContain(status);
    }
  });

  it('every archivable status can in fact be archived', () => {
    for (const status of ARCHIVABLE_STATUSES) expect(canTransition(status, 'ARCHIVED')).toBe(true);
  });
});

describe('evidence slots', () => {
  it('requires the four sides, the plate and the four documents; the interior is optional', () => {
    expect(REQUIRED_SLOTS).toHaveLength(9);
    expect(REQUIRED_SLOTS).not.toContain('PHOTO_INTERIOR');
    expect(EVIDENCE_SLOTS).toContain('PHOTO_INTERIOR');
  });

  it('maps every slot to its document purpose', () => {
    expect(purposeOfSlot('REGISTRATION')).toBe('VEHICLE_REGISTRATION');
    expect(purposeOfSlot('INSURANCE')).toBe('VEHICLE_INSURANCE');
    expect(purposeOfSlot('PHOTO_PLATE')).toBe('VEHICLE_PHOTO');
    expect(purposeOfSlot('PHOTO_INTERIOR')).toBe('VEHICLE_PHOTO');
  });
});

describe('text and identifier normalization', () => {
  it('accepts Latin and Amharic names and collapses spaces', () => {
    expect(normalizeDisplayText('  Toyota   Hilux ', 60)).toBe('Toyota Hilux');
    expect(normalizeDisplayText('ቶዮታ', 60)).toBe('ቶዮታ');
    expect(normalizeDisplayText('Land Rover (Defender) 110', 60)).toBe('Land Rover (Defender) 110');
  });

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Toy\u0000ota', 'NUL'],
    ['Toy\u200Bota', 'zero-width space'],
    ['Toy\u202Eota', 'bidi override'],
    ['<script>alert(1)</script>', 'markup'],
    ['a'.repeat(61), 'too long'],
    ['Toy\novota', 'newline'],
  ])('rejects %j (%s)', (input) => {
    expect(normalizeDisplayText(input, 60)).toBeNull();
  });

  it('normalizes plates: case, separators and Unicode forms', () => {
    const plate = normalizePlate({ region: 'aa', code: ' 2 ', number: '12-345' });
    expect(plate?.normalized).toBe('AA-2-12345');
    expect(normalizePlate({ region: 'AA', code: '2', number: '12345' })?.normalized).toBe(
      'AA-2-12345',
    );
    // Full-width digits fold to ASCII under NFKC.
    expect(normalizePlate({ region: 'ＡＡ', code: '２', number: '12345' })?.normalized).toBe(
      'AA-2-12345',
    );
    // Parts never merge into one another.
    expect(normalizePlate({ region: 'A', code: 'BC', number: '1' })?.normalized).not.toBe(
      normalizePlate({ region: 'AB', code: 'C', number: '1' })?.normalized,
    );
  });

  it.each([
    [{ region: '', code: '2', number: '1' }],
    [{ region: 'AA', code: '2', number: 'x'.repeat(13) }],
    [{ region: 'AA', code: '2', number: '12\u0000' }],
    [{ region: 'AA', code: '2', number: '12\u200B34' }],
    [{ region: 'AA', code: "2';--", number: '1' }],
    [{ region: 'AA', code: '-', number: '1' }],
  ])('rejects the plate %j', (input) => {
    expect(normalizePlate(input)).toBeNull();
  });

  it('normalizes VIN and engine numbers and rejects odd characters', () => {
    expect(normalizeVin(' jtdkb20u 777-123456 ')).toBe('JTDKB20U777123456');
    expect(normalizeVin('abc')).toBeNull();
    expect(normalizeVin('ABCDE!12345')).toBeNull();
    expect(normalizeVin('A'.repeat(26))).toBeNull();
    expect(normalizeEngineNumber('2nz-fe 123')).toBe('2NZFE123');
    expect(normalizeEngineNumber('x')).toBeNull();
    expect(maskIdentifier('3456')).toBe('••••3456');
  });

  it('bounds year and seats', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    expect(validYear(1979, now)).toBe(false);
    expect(validYear(1980, now)).toBe(true);
    expect(validYear(2027, now)).toBe(true);
    expect(validYear(2028, now)).toBe(false);
    expect(validYear(2018.5, now)).toBe(false);
    expect(validSeats(0)).toBe(false);
    expect(validSeats(60)).toBe(true);
    expect(validSeats(61)).toBe(false);
  });

  it('knows which fields are material', () => {
    expect(isMaterial('plate')).toBe(true);
    expect(isMaterial('vin')).toBe(true);
    expect(isMaterial('color')).toBe(false);
    expect(isMaterial('seats')).toBe(false);
  });
});

describe('submission and approval', () => {
  it('has no problems for a complete vehicle of a verified owner', () => {
    expect(submissionProblems(OWNER, evidence(), TODAY)).toEqual([]);
  });

  it('lists every missing slot', () => {
    expect(submissionProblems(OWNER, [], TODAY)).toEqual(REQUIRED_SLOTS.map((s) => `${s}_MISSING`));
  });

  it('treats an unavailable or rejected document as missing', () => {
    const problems = submissionProblems(
      OWNER,
      evidence({
        PHOTO_FRONT: { uploadStatus: 'UPLOADED' },
        PHOTO_BACK: { reviewStatus: 'REJECTED' },
      }),
      TODAY,
    );
    expect(problems).toEqual(['PHOTO_FRONT_MISSING', 'PHOTO_BACK_MISSING']);
  });

  it('flags insurance and inspection that ended before today, but not ending today', () => {
    const items = evidence({
      INSURANCE: { expiresOn: '2026-11-19' },
      INSPECTION: { expiresOn: TODAY },
    });
    expect(submissionProblems(OWNER, items, TODAY)).toEqual(['INSURANCE_EXPIRED']);
    expect(evidenceExpired(items, TODAY)).toBe(true);
    expect(evidenceExpired(evidence(), TODAY)).toBe(false);
  });

  it('reports owner problems first', () => {
    expect(
      submissionProblems(
        { ...OWNER, ownerStatus: 'PENDING', accountStatus: 'SUSPENDED' },
        evidence(),
        TODAY,
      ),
    ).toEqual(['ACCOUNT_NOT_ACTIVE', 'OWNER_NOT_VERIFIED']);
    expect(submissionProblems({ ...OWNER, ownerStatus: 'SUSPENDED' }, evidence(), TODAY)).toEqual([
      'OWNER_SUSPENDED',
    ]);
    expect(approvalBlockers({ ...OWNER, identityStatus: 'EXPIRED' }, evidence(), TODAY)).toEqual([
      'IDENTITY_NOT_VERIFIED',
    ]);
  });
});

describe('eligibility (computed, not availability)', () => {
  it('is eligible only for an approved vehicle with valid evidence and a verified owner', () => {
    expect(vehicleEligibility('APPROVED', OWNER, evidence(), TODAY)).toEqual({
      eligible: true,
      blockers: [],
    });
  });

  it.each([
    'DRAFT',
    'SUBMITTED',
    'UNDER_REVIEW',
    'REJECTED',
    'EXPIRED',
    'SUSPENDED',
    'ARCHIVED',
  ] as const)('is not eligible when %s (BR-VEH-3)', (status) => {
    expect(vehicleEligibility(status, OWNER, evidence(), TODAY)).toEqual({
      eligible: false,
      blockers: ['VEHICLE_NOT_APPROVED'],
    });
  });

  it('loses eligibility when the owner does, or the evidence ends', () => {
    expect(
      vehicleEligibility('APPROVED', { ...OWNER, ownerStatus: 'SUSPENDED' }, evidence(), TODAY)
        .blockers,
    ).toEqual(['OWNER_SUSPENDED']);
    expect(
      vehicleEligibility(
        'APPROVED',
        OWNER,
        evidence({ INSPECTION: { expiresOn: '2026-01-01' } }),
        TODAY,
      ).blockers,
    ).toEqual(['EVIDENCE_EXPIRED']);
  });
});
