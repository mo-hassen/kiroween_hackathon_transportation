import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { IsEthiopianMobile } from '../../../common/validation/ethiopian-mobile.decorator.js';
import type { AccountStatus, StaffRole } from '../../../generated/prisma/client.js';

export const STAFF_ROLES: StaffRole[] = [
  'SUPPORT',
  'VERIFICATION_OFFICER',
  'FINANCE',
  'SUPER_ADMIN',
];

export class CreateStaffDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiProperty({ enum: STAFF_ROLES, isArray: true })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(4)
  @ArrayUnique()
  @IsIn(STAFF_ROLES, { each: true })
  roles!: StaffRole[];
}

export class GrantRoleDto {
  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES)
  role!: StaffRole;
}

export class StaffRoleResponse {
  @ApiProperty({ enum: STAFF_ROLES }) role!: StaffRole;
  @ApiProperty({ format: 'date-time' }) grantedAt!: string;
}

export class StaffResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() phone!: string;
  @ApiProperty({ nullable: true, type: String }) displayName!: string | null;
  @ApiProperty() status!: AccountStatus;
  @ApiProperty({ description: 'Authenticator app enrolled' }) mfaEnrolled!: boolean;
  @ApiProperty({ type: [StaffRoleResponse] }) roles!: StaffRoleResponse[];
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class StaffActivationResponse {
  @ApiProperty({ type: StaffResponse }) staff!: StaffResponse;
  @ApiProperty({
    example: 'ABCD-EFGH-JKMN',
    description: 'Shown once. Hand over in person or by phone.',
  })
  activationCode!: string;
  @ApiProperty({ format: 'date-time' }) activationExpiresAt!: string;
}
