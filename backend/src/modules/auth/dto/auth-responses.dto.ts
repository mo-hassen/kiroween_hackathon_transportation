import { ApiProperty } from '@nestjs/swagger';
import type { TokenPair } from '../sessions/session.service.js';

/** Response of POST /auth/otp and /auth/password/reset/request: identical for every number. */
export class OtpAcceptedResponse {
  @ApiProperty({ example: true }) accepted!: true;
  @ApiProperty({ example: 300, description: 'Lifetime of a code, if one was sent' })
  expiresInSeconds!: number;
}

export class RegisteredResponse {
  @ApiProperty({ format: 'uuid' }) userId!: string;
}

export class AuthenticatedResponse {
  @ApiProperty({ enum: ['AUTHENTICATED'] }) result!: 'AUTHENTICATED';
  @ApiProperty() accessToken!: string;
  @ApiProperty({ format: 'date-time' }) accessTokenExpiresAt!: string;
  @ApiProperty({ description: 'Opaque, rotating. Store in secure storage only.' })
  refreshToken!: string;
  @ApiProperty({ format: 'date-time', description: 'Absolute session expiry' })
  refreshTokenExpiresAt!: string;
  @ApiProperty({ format: 'uuid' }) sessionId!: string;
}

export class OtpRequiredResponse {
  @ApiProperty({ enum: ['OTP_REQUIRED'] }) result!: 'OTP_REQUIRED';
  @ApiProperty({ description: 'Send with the SMS code to POST /auth/login/verify' })
  loginTicket!: string;
  @ApiProperty({ format: 'date-time' }) otpExpiresAt!: string;
}

export class StaffEnrollmentResponse {
  @ApiProperty() enrollmentTicket!: string;
  @ApiProperty({ description: 'Base32 TOTP secret, shown once' }) totpSecret!: string;
  @ApiProperty() otpauthUri!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}

export function authenticatedResponse(pair: TokenPair): AuthenticatedResponse {
  return {
    result: 'AUTHENTICATED',
    accessToken: pair.accessToken,
    accessTokenExpiresAt: pair.accessTokenExpiresAt.toISOString(),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: pair.refreshTokenExpiresAt.toISOString(),
    sessionId: pair.sessionId,
  };
}
