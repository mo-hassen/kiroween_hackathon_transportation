import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import type { DevicePlatform } from '../../../generated/prisma/client.js';

const PLATFORMS: DevicePlatform[] = ['ANDROID', 'IOS', 'WEB'];

/** The app installation making the request. The installation id is random per install. */
export class DeviceDto {
  @ApiProperty({ example: '6f1c2a9e-1b7d-4c4e-9d55-0f8f1b2c3d4e' })
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{8,128}$/)
  installationId!: string;

  @ApiProperty({ enum: PLATFORMS })
  @IsIn(PLATFORMS)
  platform!: DevicePlatform;

  @ApiPropertyOptional({ example: 'SM-A125F' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ example: '0.2.0' })
  @IsOptional()
  @IsString()
  @Matches(/^[0-9A-Za-z.+-]{1,32}$/)
  appVersion?: string;
}
