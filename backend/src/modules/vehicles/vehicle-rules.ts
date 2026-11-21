import type {
  AccountStatus,
  DocumentPurpose,
  DocumentUploadStatus,
  IdentityStatus,
  OwnerVerificationStatus,
  ReviewReasonCode,
  ReviewStatus,
  VehicleEvidenceSlot,
  VehicleFuelType,
  VehicleStatus,
  VehicleTransmission,
  VehicleType,
} from '../../generated/prisma/client.js';
import { ownerBlockers } from '../owners/owner-rules.js';

/**
 * Vehicle verification rules (docs/architecture/02-domain-model-and-rules.md §3.3). Pure
 * functions: the services and the database trigger `vehicles_guard` enforce the same table,
 * and test/integration/vehicle-db-constraints.spec.ts checks they agree.
 *
 * Three separate concepts: owner verification (Phase 6), vehicle verification (this status)
 * and marketplace availability (a later phase). An APPROVED vehicle is not listed or available.
 */
export const VEHICLE_TRANSITIONS: Readonly<Record<VehicleStatus, readonly VehicleStatus[]>> =
  Object.freeze({
    DRAFT: ['SUBMITTED', 'ARCHIVED'],
    SUBMITTED: ['UNDER_REVIEW'],
    // UNDER_REVIEW -> UNDER_REVIEW (claim takeover) is not a status change.
    UNDER_REVIEW: ['SUBMITTED', 'APPROVED', 'REJECTED'],
    REJECTED: ['DRAFT', 'ARCHIVED'],
    // A material or evidence change sends an approved vehicle back to SUBMITTED.
    APPROVED: ['SUBMITTED', 'EXPIRED', 'SUSPENDED', 'ARCHIVED'],
    SUSPENDED: ['APPROVED', 'EXPIRED'],
    EXPIRED: ['DRAFT', 'ARCHIVED'],
    ARCHIVED: [],
  });

export function canTransition(from: VehicleStatus, to: VehicleStatus): boolean {
  return VEHICLE_TRANSITIONS[from].includes(to);
}

/** The owner may change the vehicle's details and evidence in these statuses. */
export const EDITABLE_STATUSES: readonly VehicleStatus[] = ['DRAFT', 'REJECTED', 'EXPIRED'];
/** Archiving is for vehicles nobody is reviewing or has suspended. */
export const ARCHIVABLE_STATUSES: readonly VehicleStatus[] = [
  'DRAFT',
  'REJECTED',
  'EXPIRED',
  'APPROVED',
];
/** Statuses officers may open (anything that was ever submitted). */
export const REVIEWABLE_STATUSES: readonly VehicleStatus[] = [
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
];

export const VEHICLE_TYPES: readonly VehicleType[] = [
  'SEDAN',
  'HATCHBACK',
  'SUV',
  'MINIBUS',
  'PICKUP',
  'THREE_WHEELER',
  'OTHER',
];
export const VEHICLE_TRANSMISSIONS: readonly VehicleTransmission[] = ['MANUAL', 'AUTOMATIC'];
export const VEHICLE_FUEL_TYPES: readonly VehicleFuelType[] = [
  'PETROL',
  'DIESEL',
  'ELECTRIC',
  'HYBRID',
  'OTHER',
];
export const VEHICLE_STATUSES: readonly VehicleStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'SUSPENDED',
  'ARCHIVED',
];

export const VEHICLE_REJECT_REASONS: readonly ReviewReasonCode[] = [
  'BLURRY',
  'EXPIRED',
  'NOT_OWNER',
  'INCOMPLETE',
  'VEHICLE_DETAILS_MISMATCH',
  'INVALID_DOCUMENT',
  'SUSPECTED_FRAUD',
  'OTHER',
];
export const VEHICLE_SUSPEND_REASONS: readonly ReviewReasonCode[] = [
  'SUSPECTED_FRAUD',
  'SAFETY_CONCERN',
  'NOT_OWNER',
  'OTHER',
];

// --- Evidence ---------------------------------------------------------------

export const EVIDENCE_SLOTS: readonly VehicleEvidenceSlot[] = [
  'REGISTRATION',
  'OWNERSHIP',
  'INSURANCE',
  'INSPECTION',
  'PHOTO_FRONT',
  'PHOTO_BACK',
  'PHOTO_LEFT',
  'PHOTO_RIGHT',
  'PHOTO_PLATE',
  'PHOTO_INTERIOR',
];
/** 04 "vehicle photos": at least four sides and the plate. The interior is optional. */
export const REQUIRED_SLOTS: readonly VehicleEvidenceSlot[] = EVIDENCE_SLOTS.filter(
  (slot) => slot !== 'PHOTO_INTERIOR',
);
/** Insurance and inspection certificates carry an end date the owner enters. */
export const EXPIRING_SLOTS: readonly VehicleEvidenceSlot[] = ['INSURANCE', 'INSPECTION'];

export function purposeOfSlot(slot: VehicleEvidenceSlot): DocumentPurpose {
  switch (slot) {
    case 'REGISTRATION':
      return 'VEHICLE_REGISTRATION';
    case 'OWNERSHIP':
      return 'VEHICLE_OWNERSHIP';
    case 'INSURANCE':
      return 'VEHICLE_INSURANCE';
    case 'INSPECTION':
      return 'VEHICLE_INSPECTION';
    default:
      return 'VEHICLE_PHOTO';
  }
}

// --- Dates --------------------------------------------------------------------

/** Re-exported so vehicle code does not reach into the drivers module for date handling. */
export { addisToday, isoDate, parseIsoDate } from '../drivers/driver-rules.js';

export const MIN_VEHICLE_YEAR = 1980;
/** The newest model year the market can plausibly carry: next calendar year. */
export function maxVehicleYear(now: Date = new Date()): number {
  return now.getUTCFullYear() + 1;
}
export function validYear(year: number, now: Date = new Date()): boolean {
  return Number.isInteger(year) && year >= MIN_VEHICLE_YEAR && year <= maxVehicleYear(now);
}
export function validSeats(seats: number): boolean {
  return Number.isInteger(seats) && seats >= 1 && seats <= 60;
}

// --- Text normalization ---------------------------------------------------------

/** Letters, marks, digits and a few separators: Amharic (Ethiopic) is a letter script. */
const DISPLAY_TEXT = /^[\p{L}\p{M}\p{N} .,'\-/&()+]+$/u;
/** Control, format (zero-width, bidi overrides), separator and unassigned characters. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}\p{Zl}\p{Zp}]/u;

function collapse(input: string): string {
  return input.normalize('NFC').trim().replace(/\s+/gu, ' ');
}

/** Make, model and colour: 1–[max] characters, no hidden or markup-like characters. */
export function normalizeDisplayText(input: string, max: number): string | null {
  if (HIDDEN.test(input)) return null;
  const value = collapse(input);
  if (value.length < 1 || value.length > max) return null;
  return DISPLAY_TEXT.test(value) ? value : null;
}

export interface PlateParts {
  readonly region: string;
  readonly code: string;
  readonly number: string;
}

const PLATE_PART = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} -]*$/u;

function normalizePlatePart(input: string): string | null {
  if (HIDDEN.test(input)) return null;
  const value = collapse(input);
  if (value.length < 1 || value.length > 12) return null;
  return PLATE_PART.test(value) ? value : null;
}

/**
 * [ASSUMPTION] No Ethiopian plate format is hard-coded (formats vary by region, vehicle class
 * and era; officers compare the plate with the registration book). Each of the three parts is
 * 1–12 letters (any script) or digits, with inner spaces or hyphens allowed.
 */
export function normalizePlate(input: {
  region: string;
  code: string;
  number: string;
}): (PlateParts & { normalized: string }) | null {
  const region = normalizePlatePart(input.region);
  const code = normalizePlatePart(input.code);
  const number = normalizePlatePart(input.number);
  if (region === null || code === null || number === null) return null;
  const key = (part: string): string => part.normalize('NFKC').toUpperCase().replace(/[\s-]/gu, '');
  const parts = [key(region), key(code), key(number)];
  if (parts.some((part) => part.length === 0)) return null;
  return { region, code, number, normalized: parts.join('-') };
}

/**
 * [ASSUMPTION] VIN and engine number: upper case, spaces and hyphens removed, then letters and
 * digits only. VINs are 17 characters on modern vehicles, but older and imported vehicles
 * vary, so only a permissive length range is enforced; officers compare with the registration.
 */
export function normalizeVin(input: string): string | null {
  const value = input.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{5,25}$/.test(value) ? value : null;
}
export function normalizeEngineNumber(input: string): string | null {
  const value = input.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '');
  return /^[A-Z0-9]{3,30}$/.test(value) ? value : null;
}
export function maskIdentifier(last4: string): string {
  return `••••${last4}`;
}

/** Material details: changing one of these on an approved vehicle forces re-verification. */
export const MATERIAL_FIELDS = [
  'vehicleType',
  'make',
  'model',
  'year',
  'plate',
  'vin',
  'engineNumber',
] as const;
export type MaterialField = (typeof MATERIAL_FIELDS)[number];
export function isMaterial(field: string): field is MaterialField {
  return (MATERIAL_FIELDS as readonly string[]).includes(field);
}

// --- Submission and approval ------------------------------------------------------

export interface EvidenceFacts {
  readonly slot: VehicleEvidenceSlot;
  readonly uploadStatus: DocumentUploadStatus;
  readonly reviewStatus: ReviewStatus;
  /** `YYYY-MM-DD`, insurance and inspection only. */
  readonly expiresOn: string | null;
}

export interface OwnerFacts {
  readonly accountStatus: AccountStatus;
  readonly identityStatus: IdentityStatus;
  readonly ownerStatus: OwnerVerificationStatus;
}

/** Stable codes the clients localize. */
export type SubmissionProblem =
  | 'ACCOUNT_NOT_ACTIVE'
  | 'IDENTITY_NOT_VERIFIED'
  | 'OWNER_NOT_VERIFIED'
  | 'OWNER_SUSPENDED'
  | `${VehicleEvidenceSlot}_MISSING`
  | 'INSURANCE_EXPIRED'
  | 'INSPECTION_EXPIRED';

function usable(evidence: EvidenceFacts): boolean {
  // A document an officer rejected earlier is never reused: upload a new one.
  return evidence.uploadStatus === 'AVAILABLE' && evidence.reviewStatus !== 'REJECTED';
}

/** What blocks a submission (owner state, missing or expired evidence). Server-computed. */
export function submissionProblems(
  owner: OwnerFacts,
  evidence: readonly EvidenceFacts[],
  today: string,
): SubmissionProblem[] {
  const problems: SubmissionProblem[] = ownerBlockers({
    accountStatus: owner.accountStatus,
    identityStatus: owner.identityStatus,
    status: owner.ownerStatus,
  });
  for (const slot of REQUIRED_SLOTS) {
    const item = evidence.find((e) => e.slot === slot);
    if (item === undefined || !usable(item)) {
      problems.push(`${slot}_MISSING`);
    } else if (item.expiresOn !== null && item.expiresOn < today) {
      problems.push(slot === 'INSURANCE' ? 'INSURANCE_EXPIRED' : 'INSPECTION_EXPIRED');
    }
  }
  return problems;
}

/** Re-checked inside every approval and reinstatement transaction. */
export function approvalBlockers(
  owner: OwnerFacts,
  evidence: readonly EvidenceFacts[],
  today: string,
): SubmissionProblem[] {
  return submissionProblems(owner, evidence, today);
}

/** True when an approved vehicle's insurance or inspection ended before [today]. */
export function evidenceExpired(evidence: readonly EvidenceFacts[], today: string): boolean {
  return evidence.some(
    (e) => EXPIRING_SLOTS.includes(e.slot) && e.expiresOn !== null && e.expiresOn < today,
  );
}

export type VehicleEligibilityBlocker =
  | 'VEHICLE_NOT_APPROVED'
  | 'EVIDENCE_EXPIRED'
  | 'ACCOUNT_NOT_ACTIVE'
  | 'IDENTITY_NOT_VERIFIED'
  | 'OWNER_NOT_VERIFIED'
  | 'OWNER_SUSPENDED';

/**
 * Whether the vehicle could be offered in a later phase's marketplace: computed, never stored
 * or client-settable (BR-VEH-3). It is not availability: nothing here lists the vehicle.
 */
export function vehicleEligibility(
  status: VehicleStatus,
  owner: OwnerFacts,
  evidence: readonly EvidenceFacts[],
  today: string,
): { eligible: boolean; blockers: VehicleEligibilityBlocker[] } {
  const blockers: VehicleEligibilityBlocker[] = [];
  if (status !== 'APPROVED') blockers.push('VEHICLE_NOT_APPROVED');
  if (evidenceExpired(evidence, today)) blockers.push('EVIDENCE_EXPIRED');
  blockers.push(
    ...ownerBlockers({
      accountStatus: owner.accountStatus,
      identityStatus: owner.identityStatus,
      status: owner.ownerStatus,
    }),
  );
  return { eligible: blockers.length === 0, blockers };
}

/** Optional-field values the PATCH body may change, after validation. */
export type NonMaterialField = 'color' | 'seats' | 'transmission' | 'fuelType';
