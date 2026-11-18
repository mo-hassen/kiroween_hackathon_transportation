import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { Equals, IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type {
  IdentityProviderCode,
  IdentityStatus,
  IdentityVerificationStatus,
  Locale,
} from '../../../generated/prisma/client.js';
import { CLIENT_REASONS, type ClientReason } from '../identity-state.js';

const LOCALES: Locale[] = ['en', 'am'];
const IDENTITY_STATUSES: IdentityStatus[] = [
  'UNVERIFIED',
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'SUSPENDED',
  'EXPIRED',
  'REVERIFICATION_REQUIRED',
];
const ATTEMPT_STATUSES: IdentityVerificationStatus[] = [
  'PENDING',
  'VERIFIED',
  'REJECTED',
  'FAILED',
  'EXPIRED',
  'CANCELLED',
  'SUPERSEDED',
  'SUSPENDED',
  'REVERIFICATION_REQUIRED',
];

/**
 * Starting a verification. There is deliberately no status, provider or result field:
 * the outcome only ever comes from the provider callback (BR-ID-1).
 */
export class StartVerificationDto {
  @ApiProperty({
    enum: [true],
    description: 'The user read and accepted the consent text shown in the app',
  })
  @Equals(true)
  consent!: true;

  @ApiPropertyOptional({ enum: LOCALES, description: 'Language of the provider pages' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;
}

export class VerificationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ATTEMPT_STATUSES }) status!: IdentityVerificationStatus;
  @ApiProperty({
    enum: CLIENT_REASONS,
    nullable: true,
    description: 'Coarse reason for an attempt that ended without a verified identity',
  })
  reason!: ClientReason | null;
  @ApiProperty({ enum: ['DEV', 'FAYDA_ESIGNET'] }) provider!: IdentityProviderCode;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', description: 'The attempt must finish before this' })
  sessionExpiresAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  verifiedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  validUntil!: string | null;
}

export class StartVerificationResponse {
  @ApiProperty({ type: VerificationResponse }) verification!: VerificationResponse;
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Open in the system browser (Custom Tab), never in a WebView. Null once the attempt has ended.',
  })
  authorizationUrl!: string | null;
}

/** GET /identity/verifications/current: everything the app needs, nothing more. */
export class IdentityOverviewResponse {
  @ApiProperty({ enum: IDENTITY_STATUSES }) identityStatus!: IdentityStatus;
  @ApiProperty({ description: 'Whether POST /identity/verifications is allowed now' })
  canStart!: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Own verified name (VERIFIED only)' })
  verifiedName!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  verifiedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  validUntil!: string | null;
  @ApiProperty({ type: VerificationResponse, nullable: true })
  latest!: VerificationResponse | null;
}

/** Staff actions are always audited with a reason. */
export class StaffReasonDto {
  @ApiProperty({ minLength: 10, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/** Verification officer view (identity.review). Every read is audited. */
export class AdminVerificationResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) userId!: string;
  @ApiProperty({ enum: ['DEV', 'FAYDA_ESIGNET'] }) provider!: IdentityProviderCode;
  @ApiProperty({ enum: ATTEMPT_STATUSES }) status!: IdentityVerificationStatus;
  @ApiProperty({ nullable: true, type: String, description: 'Internal outcome code' })
  outcomeCode!: string | null;
  @ApiProperty({ enum: IDENTITY_STATUSES }) accountIdentityStatus!: IdentityStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  verifiedAt!: string | null;
  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  validUntil!: string | null;
  @ApiProperty({ nullable: true, type: String }) assuranceLevel!: string | null;
  @ApiProperty({ nullable: true, type: String }) verifiedFullName!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'YYYY-MM-DD' })
  verifiedDateOfBirth!: string | null;
  @ApiProperty({
    format: 'uuid',
    nullable: true,
    type: String,
    description: 'Another account holding the identity this attempt presented, if any',
  })
  conflictingUserId!: string | null;
}

export class StaffReasonQuery {
  @ApiProperty({ minLength: 10, maxLength: 500, description: 'Why the details are needed' })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class StaffActionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ATTEMPT_STATUSES }) status!: IdentityVerificationStatus;
  @ApiProperty({ enum: IDENTITY_STATUSES }) accountIdentityStatus!: IdentityStatus;
}

/** The one-time token from the browser return link (same-device confirmation). */
export class ConfirmVerificationDto {
  @ApiProperty({ description: 'The `confirmation` value of the return link', minLength: 43 })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/)
  confirmation!: string;
}
