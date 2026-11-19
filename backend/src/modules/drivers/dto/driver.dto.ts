import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  Equals,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  AddisSubCity,
  DriverEligibility,
  IdentityStatus,
  ReviewReasonCode,
  ReviewStatus,
} from '../../../generated/prisma/client.js';
import { DocumentResponse, REVIEW_STATUSES } from '../../documents/dto/document.dto.js';
import { REJECT_REASONS, SUSPEND_REASONS } from '../driver-rules.js';

export const SUB_CITIES: AddisSubCity[] = [
  'ADDIS_KETEMA',
  'AKAKY_KALITI',
  'ARADA',
  'BOLE',
  'GULLELE',
  'KIRKOS',
  'KOLFE_KERANIO',
  'LIDETA',
  'NIFAS_SILK_LAFTO',
  'YEKA',
  'LEMI_KURA',
];
const ELIGIBILITY: DriverEligibility[] = ['INELIGIBLE', 'ELIGIBLE', 'SUSPENDED'];
const REASONS: ReviewReasonCode[] = [
  'BLURRY',
  'MISMATCH_NAME',
  'EXPIRED',
  'NOT_OWNER',
  'INCOMPLETE',
  'INVALID_LICENSE_DETAILS',
  'SUSPECTED_FRAUD',
  'SAFETY_CONCERN',
  'OTHER',
];

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Driver-editable profile fields. Eligibility, suspension and review fields are never
 * accepted (unknown fields are rejected by the global pipe).
 */
export class DriverProfileDto {
  @ApiPropertyOptional({ minimum: 0, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(60)
  yearsLicensed?: number;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  bio?: string;

  @ApiPropertyOptional({ enum: SUB_CITIES })
  @IsOptional()
  @IsIn(SUB_CITIES)
  homeSubCity?: AddisSubCity;
}

export class LicenseDetailsDto {
  @ApiProperty({ description: 'As printed; spaces, hyphens, slashes and dots are ignored' })
  @IsString()
  @MinLength(4)
  @MaxLength(40)
  licenseNumber!: string;

  @ApiProperty({
    type: [String],
    description:
      '[LEGAL] Category codes as printed on the licence (not validated against an official list)',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(10, { each: true })
  categories!: string[];

  @ApiProperty({ example: '2022-03-01' })
  @Matches(DATE)
  issuedOn!: string;

  @ApiProperty({ example: '2027-03-01' })
  @Matches(DATE)
  expiresOn!: string;

  @ApiProperty({ example: 'Addis Ababa Driver and Vehicle Licensing Authority' })
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  issuingAuthority!: string;
}

export class AttachDocumentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;
}

export class LicenseResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'Masked, e.g. ••••1234' }) licenseNumberMasked!: string;
  @ApiProperty({ type: [String] }) categories!: string[];
  @ApiProperty() issuedOn!: string;
  @ApiProperty() expiresOn!: string;
  @ApiProperty() issuingAuthority!: string;
  @ApiProperty({ enum: REVIEW_STATUSES }) reviewStatus!: ReviewStatus;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ enum: REASONS, nullable: true }) decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String, description: 'Officer note (plain text)' })
  decisionNote!: string | null;
  @ApiProperty({ type: DocumentResponse, nullable: true }) frontDocument!: DocumentResponse | null;
  @ApiProperty({ type: DocumentResponse, nullable: true }) backDocument!: DocumentResponse | null;
  @ApiProperty({ description: 'Details and documents can be changed now' }) editable!: boolean;
  @ApiProperty() version!: number;
}

export class EligibilityResponse {
  @ApiProperty({ enum: ELIGIBILITY }) status!: DriverEligibility;
  @ApiProperty({
    type: [String],
    description:
      'What is missing: ACCOUNT_NOT_ACTIVE, IDENTITY_NOT_VERIFIED, LICENSE_MISSING, LICENSE_NOT_APPROVED, LICENSE_EXPIRED, DOCUMENTS_NOT_APPROVED, DRIVER_SUSPENDED',
  })
  blockers!: string[];
}

export class DriverProfileResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ nullable: true, type: Number }) yearsLicensed!: number | null;
  @ApiProperty({ nullable: true, type: String }) bio!: string | null;
  @ApiProperty({ enum: SUB_CITIES, nullable: true }) homeSubCity!: AddisSubCity | null;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ type: EligibilityResponse }) eligibility!: EligibilityResponse;
  @ApiProperty({ enum: REASONS, nullable: true }) suspendedReason!: ReviewReasonCode | null;
  @ApiProperty({ type: LicenseResponse, nullable: true }) license!: LicenseResponse | null;
  @ApiProperty({ description: 'Send as If-Match when updating the profile' }) version!: number;
}

// --- Officer side -----------------------------------------------------------

export class ReviewQueueQuery {
  @ApiPropertyOptional({ enum: REVIEW_STATUSES })
  @IsOptional()
  @IsIn(REVIEW_STATUSES)
  status?: ReviewStatus;

  @ApiPropertyOptional({ description: 'Name contains, or exact phone number', maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  q?: string;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? Number(value) : value))
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number;
}

export class ApproveDto {
  @ApiProperty({
    enum: [true],
    description: 'Officer confirms the licence matches the verified identity',
  })
  @Equals(true)
  identityMatches!: true;

  @ApiProperty({
    enum: [true],
    description: 'Officer confirms both images are legible and genuine-looking',
  })
  @Equals(true)
  documentsLegible!: true;

  @ApiProperty({
    enum: [true],
    description: 'Officer confirms number, categories and dates match the documents',
  })
  @Equals(true)
  detailsMatch!: true;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class RejectDto {
  @ApiProperty({ enum: REJECT_REASONS })
  @IsIn([...REJECT_REASONS])
  reasonCode!: ReviewReasonCode;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Shown to the driver as plain text' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class SuspendDto {
  @ApiProperty({ enum: SUSPEND_REASONS })
  @IsIn([...SUSPEND_REASONS])
  reasonCode!: ReviewReasonCode;

  @ApiProperty({ minLength: 10, maxLength: 1000, description: 'Internal; not shown to the driver' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

export class ReinstateDto {
  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

export class StaffReasonQuery {
  @ApiProperty({
    minLength: 10,
    maxLength: 500,
    description: 'Why the document is opened (audited)',
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class CaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: REVIEW_STATUSES }) reviewStatus!: ReviewStatus;
  @ApiProperty({ nullable: true, type: String }) driverName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) claimedById!: string | null;
  @ApiProperty({ description: 'Claimed by the officer making the request' }) claimedByMe!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) claimExpiresAt!:
    string | null;
  @ApiProperty() expiresOn!: string;
  @ApiProperty() version!: number;
}

export class CaseListResponse {
  @ApiProperty({ type: [CaseSummaryResponse] }) items!: CaseSummaryResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class CaseCountsResponse {
  @ApiProperty() SUBMITTED!: number;
  @ApiProperty() UNDER_REVIEW!: number;
  @ApiProperty() APPROVED!: number;
  @ApiProperty() REJECTED!: number;
  @ApiProperty() EXPIRED!: number;
  @ApiProperty() SUSPENDED!: number;
}

export class ReviewEventResponse {
  @ApiProperty() action!: string;
  @ApiProperty({ enum: REVIEW_STATUSES, nullable: true }) fromStatus!: ReviewStatus | null;
  @ApiProperty({ enum: REVIEW_STATUSES }) toStatus!: ReviewStatus;
  @ApiProperty({ enum: REASONS, nullable: true }) reasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CaseDetailResponse extends CaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) driverUserId!: string;
  @ApiProperty() driverPhone!: string;
  @ApiProperty({ description: 'Full licence number (staff only; this view is audited)' })
  licenseNumber!: string;
  @ApiProperty({ type: [String] }) categories!: string[];
  @ApiProperty() issuedOn!: string;
  @ApiProperty() issuingAuthority!: string;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Name from the verified identity' })
  identityVerifiedName!: string | null;
  @ApiProperty({ nullable: true, type: Number }) yearsLicensed!: number | null;
  @ApiProperty({ enum: SUB_CITIES, nullable: true }) homeSubCity!: AddisSubCity | null;
  @ApiProperty({ enum: ELIGIBILITY }) eligibilityStatus!: DriverEligibility;
  @ApiProperty({ enum: REASONS, nullable: true }) decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;
  @ApiProperty({ type: DocumentResponse, nullable: true }) frontDocument!: DocumentResponse | null;
  @ApiProperty({ type: DocumentResponse, nullable: true }) backDocument!: DocumentResponse | null;
  @ApiProperty({ type: [ReviewEventResponse] }) history!: ReviewEventResponse[];
}
