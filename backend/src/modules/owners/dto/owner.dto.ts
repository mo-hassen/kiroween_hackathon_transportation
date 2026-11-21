import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import type {
  AccountStatus,
  DocumentPurpose,
  IdentityStatus,
  OwnerType,
  OwnerVerificationStatus,
  ReviewReasonCode,
} from '../../../generated/prisma/client.js';
import { DocumentResponse } from '../../documents/dto/document.dto.js';
import { OWNER_REJECT_REASONS, OWNER_SUSPEND_REASONS } from '../owner-rules.js';

export const OWNER_TYPES: OwnerType[] = ['INDIVIDUAL', 'ORGANIZATION'];
export const OWNER_STATUSES: OwnerVerificationStatus[] = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
];
const OWNER_PURPOSES: DocumentPurpose[] = [
  'OWNER_TIN',
  'OWNER_BUSINESS_LICENSE',
  'OWNER_REPRESENTATIVE_LETTER',
];

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/**
 * Owner-editable fields only. Verification status, reviewers, eligibility and similar fields
 * are never accepted: unknown fields are rejected by the global validation pipe.
 */
export class CreateOwnerProfileDto {
  @ApiProperty({ enum: OWNER_TYPES })
  @IsIn(OWNER_TYPES)
  ownerType!: OwnerType;

  @ApiPropertyOptional({ maxLength: 200, description: 'ORGANIZATION only' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  organizationName?: string;

  @ApiPropertyOptional({
    maxLength: 40,
    description:
      'ORGANIZATION only. Spaces, hyphens, slashes and dots are ignored; 4–20 letters and digits. Never returned in full.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tin?: string;
}

/**
 * Changes in UNVERIFIED, REJECTED, EXPIRED and REVERIFICATION_REQUIRED. The type can only
 * change in UNVERIFIED and REJECTED; switching to ORGANIZATION needs a name and a TIN.
 */
export class UpdateOwnerProfileDto {
  @ApiPropertyOptional({ enum: OWNER_TYPES })
  @IsOptional()
  @IsIn(OWNER_TYPES)
  ownerType?: OwnerType;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  organizationName?: string;

  @ApiPropertyOptional({ maxLength: 40, description: 'Replaces the stored TIN' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  tin?: string;
}

export class AttachOwnerDocumentDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  documentId!: string;
}

export class OwnerDocumentSlot {
  @ApiProperty({ enum: OWNER_PURPOSES }) purpose!: DocumentPurpose;
  @ApiProperty({ type: DocumentResponse, nullable: true }) document!: DocumentResponse | null;
}

export class OwnerEligibilityResponse {
  @ApiProperty({ description: 'May use owner features that need verification (Phase 7+)' })
  eligible!: boolean;
  @ApiProperty({
    type: [String],
    description: 'ACCOUNT_NOT_ACTIVE, IDENTITY_NOT_VERIFIED, OWNER_NOT_VERIFIED, OWNER_SUSPENDED',
  })
  blockers!: string[];
}

export class OwnerProfileResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: OwnerType;
  @ApiProperty({ nullable: true, type: String }) organizationName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Masked, e.g. ••••1234' })
  tinMasked!: string | null;
  @ApiProperty({ enum: OWNER_STATUSES }) verificationStatus!: OwnerVerificationStatus;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Shown for REJECTED and SUSPENDED',
  })
  decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Officer note for a rejection (plain text)',
  })
  decisionNote!: string | null;
  @ApiProperty({ description: 'Details and documents can be changed now' }) editable!: boolean;
  @ApiProperty({ description: 'The owner type can be changed now' }) typeChangeAllowed!: boolean;
  @ApiProperty({ type: [OwnerDocumentSlot] }) documents!: OwnerDocumentSlot[];
  @ApiProperty({ type: [String], description: 'What still blocks a submission' })
  submissionProblems!: string[];
  @ApiProperty({ type: OwnerEligibilityResponse }) eligibility!: OwnerEligibilityResponse;
  @ApiProperty({ description: 'Send as If-Match when updating' }) version!: number;
}

export class OwnerStatusResponse {
  @ApiProperty({ enum: OWNER_STATUSES }) verificationStatus!: OwnerVerificationStatus;
  @ApiProperty({ type: [String] }) submissionProblems!: string[];
  @ApiProperty({ type: OwnerEligibilityResponse }) eligibility!: OwnerEligibilityResponse;
}

// --- Officer side -----------------------------------------------------------

const booleanString = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

export class OwnerQueueQuery {
  @ApiPropertyOptional({ enum: OWNER_STATUSES })
  @IsOptional()
  @IsIn(OWNER_STATUSES)
  status?: OwnerVerificationStatus;

  @ApiPropertyOptional({ enum: OWNER_TYPES })
  @IsOptional()
  @IsIn(OWNER_TYPES)
  ownerType?: OwnerType;

  @ApiPropertyOptional({
    type: Boolean,
    description: 'PENDING organizations with a first approval',
  })
  @IsOptional()
  @Transform(booleanString)
  @IsIn([true, false])
  awaitingSecondApproval?: boolean;

  @ApiPropertyOptional({
    description: 'Name or organization name contains, or exact phone number',
    maxLength: 60,
  })
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

const note = (): PropertyDecorator => (target, key) => {
  ApiPropertyOptional({ maxLength: 1000 })(target, key);
  IsOptional()(target, key);
  Transform(trim)(target, key);
  IsString()(target, key);
  MaxLength(1000)(target, key);
};

export class ApproveIndividualDto {
  @ApiProperty({
    enum: [true],
    description: 'Officer confirms the account holder is the verified identity',
  })
  @Equals(true)
  identityConfirmed!: true;

  @note()
  note?: string;
}

/** Used for both organization approvals; each officer confirms every check independently. */
export class OrganizationApprovalDto {
  @ApiProperty({ enum: [true], description: 'The representative is the verified identity' })
  @Equals(true)
  identityConfirmed!: true;

  @ApiProperty({ enum: [true], description: 'All three documents are legible and genuine-looking' })
  @Equals(true)
  documentsLegible!: true;

  @ApiProperty({ enum: [true], description: 'Organization name and TIN match the documents' })
  @Equals(true)
  organizationDetailsMatch!: true;

  @ApiProperty({
    enum: [true],
    description: 'The letter authorizes this representative for the organization',
  })
  @Equals(true)
  representativeAuthorized!: true;

  @note()
  note?: string;
}

export class OwnerRejectDto {
  @ApiProperty({ enum: OWNER_REJECT_REASONS })
  @IsIn([...OWNER_REJECT_REASONS])
  reasonCode!: ReviewReasonCode;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Shown to the owner as plain text' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class OwnerSuspendDto {
  @ApiProperty({ enum: OWNER_SUSPEND_REASONS })
  @IsIn([...OWNER_SUSPEND_REASONS])
  reasonCode!: ReviewReasonCode;

  @ApiProperty({ minLength: 10, maxLength: 1000, description: 'Internal; not shown to the owner' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

export class OwnerReinstateDto {
  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

/**
 * The officer types the TIN as printed on the certificate; the server compares it with the
 * stored HMAC. The stored TIN is never decrypted or returned.
 */
export class TinCheckDto {
  @ApiProperty({
    maxLength: 40,
    description: 'As printed on the TIN certificate; never stored or logged',
  })
  @IsString()
  @MaxLength(40)
  tin!: string;

  @ApiProperty({ minLength: 10, maxLength: 500, description: 'Why the check is made (audited)' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class TinCheckResponse {
  @ApiProperty({ description: 'The typed TIN equals the stored TIN (after normalization)' })
  matches!: boolean;
  @ApiProperty({ format: 'date-time' }) checkedAt!: string;
}

export class OwnerCaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: OWNER_TYPES }) ownerType!: OwnerType;
  @ApiProperty({ enum: OWNER_STATUSES }) verificationStatus!: OwnerVerificationStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Name in the app' })
  displayName!: string | null;
  @ApiProperty({ nullable: true, type: String }) organizationName!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) claimedById!: string | null;
  @ApiProperty() claimedByMe!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) claimExpiresAt!:
    string | null;
  @ApiProperty({ description: 'PENDING organization with a first approval' })
  awaitingSecondApproval!: boolean;
  @ApiProperty({ description: 'The caller gave the first approval (cannot give the second)' })
  firstApprovedByMe!: boolean;
  @ApiProperty() version!: number;
}

export class OwnerCaseListResponse {
  @ApiProperty({ type: [OwnerCaseSummaryResponse] }) items!: OwnerCaseSummaryResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}

export class OwnerCaseCountsResponse {
  @ApiProperty() PENDING_INDIVIDUAL!: number;
  @ApiProperty({ description: 'Organizations without a first approval' })
  PENDING_ORGANIZATION!: number;
  @ApiProperty() AWAITING_SECOND_APPROVAL!: number;
  @ApiProperty() VERIFIED!: number;
  @ApiProperty() REJECTED!: number;
  @ApiProperty() SUSPENDED!: number;
  @ApiProperty() EXPIRED!: number;
  @ApiProperty() REVERIFICATION_REQUIRED!: number;
}

export class OwnerReviewEventResponse {
  @ApiProperty() action!: string;
  @ApiProperty({ enum: OWNER_STATUSES, nullable: true })
  fromStatus!: OwnerVerificationStatus | null;
  @ApiProperty({ enum: OWNER_STATUSES }) toStatus!: OwnerVerificationStatus;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class OwnerCaseDetailResponse extends OwnerCaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) ownerUserId!: string;
  @ApiProperty() representativePhone!: string;
  @ApiProperty() accountStatus!: AccountStatus;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Name from the verified identity' })
  identityVerifiedName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Masked; the full TIN is not shown' })
  tinMasked!: string | null;
  @ApiProperty({ description: 'The caller confirmed the full TIN for this submission (TIN check)' })
  tinCheckedByMe!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) firstApprovedById!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) firstApprovedAt!:
    string | null;
  @ApiProperty({ nullable: true, type: String }) firstApprovalNote!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) verifiedById!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) verifiedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;
  @ApiProperty({ type: [OwnerDocumentSlot] }) documents!: OwnerDocumentSlot[];
  @ApiProperty({ type: [OwnerReviewEventResponse] }) history!: OwnerReviewEventResponse[];
}
