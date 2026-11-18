import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import { RawResponse } from '../../common/http/response-envelope.interceptor.js';
import {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from '../../common/idempotency/idempotency-key.decorator.js';
import {
  ConfirmVerificationDto,
  IdentityOverviewResponse,
  StartVerificationDto,
  StartVerificationResponse,
  VerificationResponse,
} from './dto/identity.dto.js';
import { type CallbackQuery, IdentityCallbackService } from './identity-callback.service.js';
import { IdentityVerificationService } from './identity-verification.service.js';

const verificationIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => validationError('id', 'IS_UUID'),
});

/** Journey J2 for the account holder. Customers only; staff get 404. */
@ApiTags('identity')
@ApiBearerAuth()
@Controller({ path: 'identity/verifications', version: '1' })
export class IdentityController {
  constructor(
    private readonly verifications: IdentityVerificationService,
    private readonly callbacks: IdentityCallbackService,
  ) {}

  @Post()
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: 'UUID; reuse it when retrying',
  })
  @ApiCreatedResponse({ type: StartVerificationResponse })
  async start(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: StartVerificationDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StartVerificationResponse> {
    const result = await this.verifications.start(principal, dto, key, meta);
    response.status(result.status);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  // Declared before ':id' so "current" is not parsed as an id.
  @Get('current')
  @ApiOkResponse({ type: IdentityOverviewResponse })
  current(@CurrentPrincipal() principal: Principal): Promise<IdentityOverviewResponse> {
    return this.verifications.overview(principal);
  }

  @Get(':id')
  @ApiOkResponse({ type: VerificationResponse })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', verificationIdPipe) id: string,
  ): Promise<VerificationResponse> {
    return this.verifications.get(principal, id);
  }

  /**
   * Completes an attempt after the provider returned a valid result. Only the session that
   * started the attempt can confirm it, with the token from the browser return link.
   */
  @Post(':id/confirm')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerificationResponse })
  confirm(
    @CurrentPrincipal() principal: Principal,
    @Param('id', verificationIdPipe) id: string,
    @Body() dto: ConfirmVerificationDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VerificationResponse> {
    return this.callbacks.confirm(principal, id, dto.confirmation, meta);
  }

  @Post(':id/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VerificationResponse })
  cancel(
    @CurrentPrincipal() principal: Principal,
    @Param('id', verificationIdPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VerificationResponse> {
    return this.verifications.cancel(principal, id, meta);
  }
}

/**
 * Browser redirect target registered with the identity provider. Not called by the app.
 * Unauthenticated by design; protected by the single-use state (see the service).
 */
@ApiTags('identity')
@Controller({ path: 'identity/callback', version: '1' })
export class IdentityCallbackController {
  constructor(private readonly callbacks: IdentityCallbackService) {}

  @Public()
  @RawResponse()
  @Get(':provider')
  @ApiResponse({
    status: HttpStatus.SEE_OTHER,
    description: 'Redirect to the app with ?verification=<id> only',
  })
  async callback(
    @Param('provider') provider: string,
    @Query() query: CallbackQuery,
    @ReqMeta() meta: RequestMeta,
    @Res() response: Response,
  ): Promise<void> {
    const target = await this.callbacks.handle(provider, query, meta);
    response.redirect(HttpStatus.SEE_OTHER, target);
  }
}
