import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type {
  AccountStatus,
  AccountType,
  IdentityStatus,
  Locale,
  StaffRole,
} from '../../generated/prisma/client.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../auth/password/password-policy.js';

const LOCALES: Locale[] = ['en', 'am'];

export class UpdateMeDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName?: string;

  @ApiPropertyOptional({ enum: LOCALES, description: 'Language for SMS and notifications' })
  @IsOptional()
  @IsIn(LOCALES)
  preferredLocale?: Locale;
}

export class ChangePasswordDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  currentPassword!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

/** The caller's own account. Explicit mapping: no database row is serialized directly. */
export class MeResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: '+251911234567' }) phone!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty({ enum: LOCALES }) preferredLocale!: Locale;
  @ApiProperty({ enum: ['CUSTOMER', 'STAFF'] }) accountType!: AccountType;
  @ApiProperty() status!: AccountStatus;
  @ApiProperty() identityStatus!: IdentityStatus;
  @ApiProperty({ type: [String], description: 'Active staff roles (empty for customers)' })
  roles!: StaffRole[];
  @ApiProperty({
    type: [String],
    description: 'Permissions of those roles (for navigation only; the API checks every call)',
  })
  permissions!: string[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ description: 'Send as If-Match when updating' }) version!: number;
}

export class SessionDeviceResponse {
  @ApiProperty() platform!: string;
  @ApiProperty({ nullable: true, type: String }) model!: string | null;
  @ApiProperty({ nullable: true, type: String }) appVersion!: string | null;
  @ApiProperty({ description: 'No SMS code needed to sign in again on this device' })
  trusted!: boolean;
}

export class SessionResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ description: 'The session making this request' }) current!: boolean;
  @ApiProperty({ type: SessionDeviceResponse, nullable: true })
  device!: SessionDeviceResponse | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ format: 'date-time' }) lastUsedAt!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
