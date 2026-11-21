import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  Equals,
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
  AccountStatus,
  IdentityStatus,
  OwnerType,
  OwnerVerificationStatus,
  ReviewReasonCode,
  VehicleEvidenceSlot,
  VehicleFuelType,
  VehicleStatus,
  VehicleTransmission,
  VehicleType,
} from '../../../generated/prisma/client.js';
import { DocumentResponse } from '../../documents/dto/document.dto.js';
import {
  EVIDENCE_SLOTS,
  VEHICLE_FUEL_TYPES,
  VEHICLE_REJECT_REASONS,
  VEHICLE_STATUSES,
  VEHICLE_SUSPEND_REASONS,
  VEHICLE_TRANSMISSIONS,
  VEHICLE_TYPES,
} from '../vehicle-rules.js';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const toNumber = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' && value.trim() !== '' ? Number(value) : value;

/**
 * Owner-editable fields only. Status, owner, reviewers, eligibility and similar fields are
 * never accepted: unknown fields are rejected by the global validation pipe. The vehicle's
 * owner always comes from the signed-in account.
 */
export class CreateVehicleDto {
  @ApiProperty({ enum: VEHICLE_TYPES }) @IsIn([...VEHICLE_TYPES]) vehicleType!: VehicleType;
  @ApiProperty({ maxLength: 60 }) @Transform(trim) @IsString() @MaxLength(60) make!: string;
  @ApiProperty({ maxLength: 60 }) @Transform(trim) @IsString() @MaxLength(60) model!: string;
  @ApiProperty({ minimum: 1980, description: 'Model year; up to next calendar year' })
  @IsInt()
  @Min(1980)
  @Max(2100)
  year!: number;
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  color?: string;
  @ApiProperty({ minimum: 1, maximum: 60 }) @IsInt() @Min(1) @Max(60) seats!: number;
  @ApiProperty({ enum: VEHICLE_TRANSMISSIONS })
  @IsIn([...VEHICLE_TRANSMISSIONS])
  transmission!: VehicleTransmission;
  @ApiProperty({ enum: VEHICLE_FUEL_TYPES })
  @IsIn([...VEHICLE_FUEL_TYPES])
  fuelType!: VehicleFuelType;
  @ApiProperty({ maxLength: 30, description: 'Plate region, as printed (1–12 characters)' })
  @IsString()
  @MaxLength(30)
  plateRegion!: string;
  @ApiProperty({ maxLength: 30, description: 'Plate code, as printed (1–12 characters)' })
  @IsString()
  @MaxLength(30)
  plateCode!: string;
  @ApiProperty({ maxLength: 30, description: 'Plate number, as printed (1–12 characters)' })
  @IsString()
  @MaxLength(30)
  plateNumber!: string;
  @ApiPropertyOptional({
    maxLength: 40,
    description:
      'Chassis number. Spaces and hyphens are ignored; 5–25 letters and digits. Never returned in full.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  vin?: string;
  @ApiPropertyOptional({
    maxLength: 40,
    description: 'Engine number; 3–30 letters and digits. Never returned.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  engineNumber?: string;
}

/** Changes in DRAFT, REJECTED and EXPIRED, and (non-material fields) on an APPROVED vehicle. */
export class UpdateVehicleDto {
  @ApiPropertyOptional({ enum: VEHICLE_TYPES })
  @IsOptional()
  @IsIn([...VEHICLE_TYPES])
  vehicleType?: VehicleType;
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  make?: string;
  @ApiPropertyOptional({ maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  model?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1980) @Max(2100) year?: number;
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(30)
  color?: string;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) @Max(60) seats?: number;
  @ApiPropertyOptional({ enum: VEHICLE_TRANSMISSIONS })
  @IsOptional()
  @IsIn([...VEHICLE_TRANSMISSIONS])
  transmission?: VehicleTransmission;
  @ApiPropertyOptional({ enum: VEHICLE_FUEL_TYPES })
  @IsOptional()
  @IsIn([...VEHICLE_FUEL_TYPES])
  fuelType?: VehicleFuelType;
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  plateRegion?: string;
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  plateCode?: string;
  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  plateNumber?: string;
  @ApiPropertyOptional({ maxLength: 40, description: 'Replaces the stored VIN' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  vin?: string;
  @ApiPropertyOptional({ maxLength: 40, description: 'Replaces the stored engine number' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  engineNumber?: string;
}

export class AttachVehicleEvidenceDto {
  @ApiProperty({ format: 'uuid' }) @IsUUID() documentId!: string;
  @ApiPropertyOptional({
    example: '2027-03-31',
    description: 'INSURANCE and INSPECTION only (required there): the date the cover ends',
  })
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  expiresOn?: string;
}

export class VehicleEvidenceItem {
  @ApiProperty({ enum: EVIDENCE_SLOTS }) slot!: VehicleEvidenceSlot;
  @ApiProperty() required!: boolean;
  @ApiProperty({ nullable: true, type: String, example: '2027-03-31' }) expiresOn!: string | null;
  @ApiProperty({ type: DocumentResponse, nullable: true }) document!: DocumentResponse | null;
}
export class VehicleEligibilityResponse {
  @ApiProperty({ description: 'Could be offered by a later marketplace phase; not availability' })
  eligible!: boolean;
  @ApiProperty({ type: [String] }) blockers!: string[];
}
export class VehiclePlate {
  @ApiProperty() region!: string;
  @ApiProperty() code!: string;
  @ApiProperty() number!: string;
}
export class VehicleResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: VEHICLE_TYPES }) vehicleType!: VehicleType;
  @ApiProperty() make!: string;
  @ApiProperty() model!: string;
  @ApiProperty() year!: number;
  @ApiProperty({ nullable: true, type: String }) color!: string | null;
  @ApiProperty() seats!: number;
  @ApiProperty({ enum: VEHICLE_TRANSMISSIONS }) transmission!: VehicleTransmission;
  @ApiProperty({ enum: VEHICLE_FUEL_TYPES }) fuelType!: VehicleFuelType;
  @ApiProperty({ type: VehiclePlate }) plate!: VehiclePlate;
  @ApiProperty({ nullable: true, type: String, description: 'Masked, e.g. ••••1234' })
  vinMasked!: string | null;
  @ApiProperty({ description: 'An engine number is on file (never returned)' })
  engineNumberOnFile!: boolean;
  @ApiProperty({ enum: VEHICLE_STATUSES }) status!: VehicleStatus;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Shown for REJECTED and SUSPENDED' })
  decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String, description: 'Officer note for a rejection' })
  decisionNote!: string | null;
  @ApiProperty({ description: 'Details and evidence can be changed now' }) editable!: boolean;
  @ApiProperty({ type: [VehicleEvidenceItem] }) evidence!: VehicleEvidenceItem[];
  @ApiProperty({ type: [String], description: 'What still blocks a submission' })
  submissionProblems!: string[];
  @ApiProperty({ type: VehicleEligibilityResponse }) eligibility!: VehicleEligibilityResponse;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'Send as If-Match when updating' }) version!: number;
}
export class VehicleListResponse {
  @ApiProperty({ type: [VehicleResponse] }) items!: VehicleResponse[];
}
export class VehicleStatusResponse {
  @ApiProperty({ enum: VEHICLE_STATUSES }) status!: VehicleStatus;
  @ApiProperty({ type: [String] }) submissionProblems!: string[];
  @ApiProperty({ type: VehicleEligibilityResponse }) eligibility!: VehicleEligibilityResponse;
}

// --- Officer side -----------------------------------------------------------

export class VehicleQueueQuery {
  @ApiPropertyOptional({ enum: VEHICLE_STATUSES })
  @IsOptional()
  @IsIn([...VEHICLE_STATUSES])
  status?: VehicleStatus;
  @ApiPropertyOptional({ enum: VEHICLE_TYPES })
  @IsOptional()
  @IsIn([...VEHICLE_TYPES])
  vehicleType?: VehicleType;
  @ApiPropertyOptional({ description: 'Plate, make, model or owner name contains', maxLength: 60 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(60)
  q?: string;
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Transform(toNumber)
  @IsInt()
  @Min(1)
  @Max(10_000)
  page?: number;
  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Transform(toNumber)
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

/** The officer confirms every check; each flag must be true to approve. */
export class ApproveVehicleDto {
  @ApiProperty({ enum: [true], description: 'Make, model, year and plate match the registration' })
  @Equals(true)
  detailsMatch!: true;
  @ApiProperty({
    enum: [true],
    description: 'The registration is in the owner’s name, or authorized',
  })
  @Equals(true)
  ownerMatchesRegistration!: true;
  @ApiProperty({ enum: [true], description: 'All documents are legible and genuine-looking' })
  @Equals(true)
  documentsLegible!: true;
  @ApiProperty({ enum: [true], description: 'The photos show this vehicle and its plate' })
  @Equals(true)
  photosMatch!: true;
  @note() note?: string;
}
export class RejectVehicleDto {
  @ApiProperty({ enum: VEHICLE_REJECT_REASONS })
  @IsIn([...VEHICLE_REJECT_REASONS])
  reasonCode!: ReviewReasonCode;
  @ApiPropertyOptional({ maxLength: 1000, description: 'Shown to the owner as plain text' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  note?: string;
}
export class SuspendVehicleDto {
  @ApiProperty({ enum: VEHICLE_SUSPEND_REASONS })
  @IsIn([...VEHICLE_SUSPEND_REASONS])
  reasonCode!: ReviewReasonCode;
  @ApiProperty({ minLength: 10, maxLength: 1000, description: 'Internal; not shown to the owner' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}
export class ReinstateVehicleDto {
  @ApiProperty({ minLength: 10, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  note!: string;
}

export class VehicleCaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: VEHICLE_TYPES }) vehicleType!: VehicleType;
  @ApiProperty() make!: string;
  @ApiProperty() model!: string;
  @ApiProperty() year!: number;
  @ApiProperty({ type: VehiclePlate }) plate!: VehiclePlate;
  @ApiProperty({ enum: VEHICLE_STATUSES }) status!: VehicleStatus;
  @ApiProperty({ nullable: true, type: String }) ownerName!: string | null;
  @ApiProperty({ enum: ['INDIVIDUAL', 'ORGANIZATION'] }) ownerType!: OwnerType;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) submittedAt!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) claimedById!: string | null;
  @ApiProperty() claimedByMe!: boolean;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) claimExpiresAt!:
    string | null;
  @ApiProperty() version!: number;
}
export class VehicleCaseListResponse {
  @ApiProperty({ type: [VehicleCaseSummaryResponse] }) items!: VehicleCaseSummaryResponse[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
export class VehicleCaseCountsResponse {
  @ApiProperty() SUBMITTED!: number;
  @ApiProperty() UNDER_REVIEW!: number;
  @ApiProperty() APPROVED!: number;
  @ApiProperty() REJECTED!: number;
  @ApiProperty() SUSPENDED!: number;
  @ApiProperty() EXPIRED!: number;
}
export class VehicleReviewEventResponse {
  @ApiProperty() action!: string;
  @ApiProperty({ enum: VEHICLE_STATUSES, nullable: true }) fromStatus!: VehicleStatus | null;
  @ApiProperty({ enum: VEHICLE_STATUSES }) toStatus!: VehicleStatus;
  @ApiProperty({ nullable: true, type: String }) reasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) note!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'uuid' }) actorUserId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}
export class VehicleCaseDetailResponse extends VehicleCaseSummaryResponse {
  @ApiProperty({ format: 'uuid' }) ownerUserId!: string;
  @ApiProperty() ownerPhone!: string;
  @ApiProperty() ownerVerificationStatus!: OwnerVerificationStatus;
  @ApiProperty() accountStatus!: AccountStatus;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ nullable: true, type: String }) color!: string | null;
  @ApiProperty() seats!: number;
  @ApiProperty({ enum: VEHICLE_TRANSMISSIONS }) transmission!: VehicleTransmission;
  @ApiProperty({ enum: VEHICLE_FUEL_TYPES }) fuelType!: VehicleFuelType;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Full VIN, only for the officer holding the claim (audited); otherwise masked',
  })
  vin!: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Masked' }) vinMasked!: string | null;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Engine number, only for the officer holding the claim (audited)',
  })
  engineNumber!: string | null;
  @ApiProperty({ nullable: true, type: String, format: 'date-time' }) decidedAt!: string | null;
  @ApiProperty({ nullable: true, type: String }) decidedById!: string | null;
  @ApiProperty({ nullable: true, type: String }) decisionReasonCode!: ReviewReasonCode | null;
  @ApiProperty({ nullable: true, type: String }) decisionNote!: string | null;
  @ApiProperty({ type: [VehicleEvidenceItem] }) evidence!: VehicleEvidenceItem[];
  @ApiProperty({ type: [String], description: 'What would block approving now' })
  approvalBlockers!: string[];
  @ApiProperty({ type: VehicleEligibilityResponse }) eligibility!: VehicleEligibilityResponse;
  @ApiProperty({ type: [VehicleReviewEventResponse] }) history!: VehicleReviewEventResponse[];
}
