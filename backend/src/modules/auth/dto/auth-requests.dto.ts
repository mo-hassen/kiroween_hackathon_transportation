import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsEthiopianMobile } from '../../../common/validation/ethiopian-mobile.decorator.js';
import type { Locale } from '../../../generated/prisma/client.js';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '../password/password-policy.js';
import { DeviceDto } from './device.dto.js';

const LOCALES: Locale[] = ['en', 'am'];
const SIX_DIGITS = /^\d{6}$/;

export class RequestOtpDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiPropertyOptional({ enum: LOCALES, description: 'Language of the SMS for a new number' })
  @IsOptional()
  @IsIn(LOCALES)
  locale?: Locale;
}

export class RegisterDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(SIX_DIGITS)
  otp!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ example: 'Abebe Kebede', maxLength: 100 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  displayName!: string;

  @ApiPropertyOptional({ enum: LOCALES })
  @IsOptional()
  @IsIn(LOCALES)
  preferredLocale?: Locale;

  @ApiProperty({ type: DeviceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class LoginDto {
  @IsEthiopianMobile()
  phone!: string;

  // No minimum here: the policy applies when a password is set, not when it is checked.
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(PASSWORD_MAX_LENGTH)
  password!: string;

  @ApiProperty({ type: DeviceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class LoginOtpDto {
  @ApiProperty({ description: 'Ticket returned by POST /auth/login when OTP_REQUIRED' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{20,200}$/)
  loginTicket!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(SIX_DIGITS)
  otp!: string;

  @ApiProperty({ type: DeviceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}

export class RefreshTokenDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  refreshToken!: string;
}

export class PasswordResetConfirmDto {
  @IsEthiopianMobile()
  phone!: string;

  @ApiProperty({ example: '123456' })
  @IsString()
  @Matches(SIX_DIGITS)
  otp!: string;

  @ApiProperty({ minLength: PASSWORD_MIN_LENGTH, maxLength: PASSWORD_MAX_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(PASSWORD_MAX_LENGTH)
  newPassword!: string;

  @ApiProperty({ type: DeviceDto })
  @IsObject()
  @ValidateNested()
  @Type(() => DeviceDto)
  device!: DeviceDto;
}
