import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsString, Matches, Max, Min } from 'class-validator';
import type {
  DocumentPurpose,
  DocumentUploadStatus,
  ReviewStatus,
} from '../../../generated/prisma/client.js';
import { ALLOWED_MIME_TYPES } from '../file-inspection.js';

export const DOCUMENT_PURPOSES: DocumentPurpose[] = [
  'DRIVER_LICENSE_FRONT',
  'DRIVER_LICENSE_BACK',
  'OWNER_TIN',
  'OWNER_BUSINESS_LICENSE',
  'OWNER_REPRESENTATIVE_LETTER',
  'VEHICLE_REGISTRATION',
  'VEHICLE_OWNERSHIP',
  'VEHICLE_INSURANCE',
  'VEHICLE_INSPECTION',
  'VEHICLE_PHOTO',
];
const UPLOAD_STATUSES: DocumentUploadStatus[] = [
  'PENDING_UPLOAD',
  'UPLOADED',
  'PROCESSING',
  'AVAILABLE',
  'INVALID',
  'INFECTED',
  'DELETED',
];
export const REVIEW_STATUSES: ReviewStatus[] = [
  'DRAFT',
  'SUBMITTED',
  'UNDER_REVIEW',
  'APPROVED',
  'REJECTED',
  'EXPIRED',
  'SUSPENDED',
];

/** POST /documents. The server, not the client, chooses the storage key. */
export class CreateUploadIntentDto {
  @ApiProperty({ enum: DOCUMENT_PURPOSES })
  @IsIn(DOCUMENT_PURPOSES)
  purpose!: DocumentPurpose;

  @ApiProperty({ enum: ALLOWED_MIME_TYPES })
  @IsIn([...ALLOWED_MIME_TYPES])
  mimeType!: string;

  @ApiProperty({ minimum: 1, maximum: 10_485_760, description: 'Exact size of the file to upload' })
  @IsInt()
  @Min(1)
  @Max(10_485_760)
  sizeBytes!: number;

  @ApiProperty({ description: 'SHA-256 of the file, hex' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsString()
  @Matches(/^[0-9a-f]{64}$/)
  sha256!: string;
}

export class DocumentResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: DOCUMENT_PURPOSES }) purpose!: DocumentPurpose;
  @ApiProperty({ enum: UPLOAD_STATUSES }) uploadStatus!: DocumentUploadStatus;
  @ApiProperty({ enum: REVIEW_STATUSES }) reviewStatus!: ReviewStatus;
  @ApiProperty() mimeType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Why validation failed, e.g. CHECKSUM_MISMATCH, TYPE_MISMATCH, MALWARE_DETECTED',
  })
  failureCode!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time', nullable: true, type: String }) processedAt!: string | null;
}

export class PresignedRequestResponse {
  @ApiProperty({ description: 'Short-lived URL for exactly one object and method' }) url!: string;
  @ApiProperty({ enum: ['PUT', 'GET'] }) method!: 'PUT' | 'GET';
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Send these headers unchanged; they are part of the signature',
  })
  headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export class UploadIntentResponse {
  @ApiProperty({ type: DocumentResponse }) document!: DocumentResponse;
  @ApiProperty({ type: PresignedRequestResponse }) upload!: PresignedRequestResponse;
}
