import { Body, Controller, HttpCode, HttpStatus, Post, Res } from '@nestjs/common';
import {
  ApiAcceptedResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { unauthenticatedError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from '../../common/idempotency/idempotency-key.decorator.js';
import { RateLimitService } from '../../common/rate-limit/rate-limit.service.js';
import { AUTH_RATE_LIMITS } from './auth-policy.js';
import {
  LoginDto,
  LoginOtpDto,
  PasswordResetConfirmDto,
  RefreshTokenDto,
  RegisterDto,
  RequestOtpDto,
} from './dto/auth-requests.dto.js';
import {
  AuthenticatedResponse,
  authenticatedResponse,
  OtpAcceptedResponse,
  OtpRequiredResponse,
  RegisteredResponse,
} from './dto/auth-responses.dto.js';
import { LoginService } from './login/login.service.js';
import { OTP_ACCEPTED, OtpRequestService } from './registration/otp-request.service.js';
import { PasswordResetService } from './registration/password-reset.service.js';
import { RegistrationService } from './registration/registration.service.js';
import { SessionService } from './sessions/session.service.js';

/** Customer authentication (journey J1). All routes are public by design. */
@ApiTags('auth')
@ApiExtraModels(AuthenticatedResponse, OtpRequiredResponse)
@Controller({ path: 'auth', version: '1' })
export class AuthController {
  constructor(
    private readonly otpRequests: OtpRequestService,
    private readonly registration: RegistrationService,
    private readonly login: LoginService,
    private readonly passwordReset: PasswordResetService,
    private readonly sessions: SessionService,
    private readonly rateLimits: RateLimitService,
  ) {}

  @Public()
  @Post('otp')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    type: OtpAcceptedResponse,
    description: 'Same response whether or not the number is registered',
  })
  async requestOtp(
    @Body() dto: RequestOtpDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OtpAcceptedResponse> {
    await this.otpRequests.requestRegistrationCode(dto.phone, dto.locale ?? 'en', meta);
    return OTP_ACCEPTED;
  }

  @Public()
  @Post('register')
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: 'UUID; reuse it when retrying',
  })
  @ApiCreatedResponse({ type: RegisteredResponse })
  async register(
    @Body() dto: RegisterDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    const result = await this.registration.register(dto, key, meta);
    response.status(result.status);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    description: 'Tokens, or OTP_REQUIRED when signing in from a new device',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(AuthenticatedResponse) },
        { $ref: getSchemaPath(OtpRequiredResponse) },
      ],
    },
  })
  async signIn(
    @Body() dto: LoginDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AuthenticatedResponse | OtpRequiredResponse> {
    const result = await this.login.login(dto, meta);
    return result.kind === 'AUTHENTICATED'
      ? authenticatedResponse(result.pair)
      : {
          result: 'OTP_REQUIRED',
          loginTicket: result.loginTicket,
          otpExpiresAt: result.otpExpiresAt.toISOString(),
        };
  }

  @Public()
  @Post('login/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthenticatedResponse })
  async verifyLogin(
    @Body() dto: LoginOtpDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AuthenticatedResponse> {
    return authenticatedResponse(await this.login.verifyStepUp(dto, meta));
  }

  @Public()
  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthenticatedResponse, description: 'Rotates the refresh token' })
  async refresh(
    @Body() dto: RefreshTokenDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AuthenticatedResponse> {
    await this.rateLimits.consume(AUTH_RATE_LIMITS.refreshPerIp, meta.ip ?? 'unknown');
    const pair = await this.sessions.rotate(dto.refreshToken, meta);
    if (pair === null) throw unauthenticatedError();
    return authenticatedResponse(pair);
  }

  @Public()
  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Always 204, also for unknown tokens' })
  async logout(@Body() dto: RefreshTokenDto, @ReqMeta() meta: RequestMeta): Promise<void> {
    await this.sessions.logout(dto.refreshToken, meta);
  }

  @Public()
  @Post('password/reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiAcceptedResponse({
    type: OtpAcceptedResponse,
    description: 'Same response whether or not the number is registered',
  })
  async requestPasswordReset(
    @Body() dto: RequestOtpDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OtpAcceptedResponse> {
    await this.otpRequests.requestPasswordResetCode(dto.phone, meta);
    return OTP_ACCEPTED;
  }

  @Public()
  @Post('password/reset/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Password changed; all sessions ended' })
  async confirmPasswordReset(
    @Body() dto: PasswordResetConfirmDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.passwordReset.confirm(dto, meta);
  }
}
