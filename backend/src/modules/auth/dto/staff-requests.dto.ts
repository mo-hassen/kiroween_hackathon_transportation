import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsObject, IsString, Matches, MaxLength, MinLength, ValidateNested } from 'class-validator';
import { IsEthiopianMobile } from '../../../common/validation/ethiopian-mobile.decorator.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password/password-policy.js';
import { DeviceDto } from './device.dto.js';

const TOTP = /^\d{6}$/;

export class StaffLoginDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: '123456', description: 'Current code from the authenticator app' })
  @IsString()
  @Matches(TOTP)
  totpCode!: string;

  @ApiProperty({ type: DeviceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class StaffActivateDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiProperty({
    example: 'ABCD-EFGH-JKMN',
    description: 'One-time code from the super administrator',
  })
  @IsString()
  @Matches(/^[A-Za-z0-9 -]{12,20}$/)
  activationCode!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;
}

export class StaffActivateConfirmDto {
  @ApiProperty()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,200}$/)
  enrollmentTicket!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(TOTP)
  totpCode!: string;
}

export class StaffReauthenticateDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(TOTP)
  totpCode!: string;
}
