import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ApiNoContentResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AdminArea } from '../../common/auth/authorization.decorators.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { Public } from '../../common/auth/public.decorator.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import {
  AuthenticatedResponse,
  authenticatedResponse,
  StaffEnrollmentResponse,
} from './dto/auth-responses.dto.js';
import {
  StaffActivateConfirmDto,
  StaffActivateDto,
  StaffLoginDto,
  StaffReauthenticateDto,
} from './dto/staff-requests.dto.js';
import { StaffAuthService } from './staff/staff-auth.service.js';

/** Staff authentication: separate from customer login, password + TOTP always. */
@ApiTags('auth: staff')
@Controller({ path: 'auth/staff', version: '1' })
export class StaffAuthController {
  constructor(private readonly staffAuth: StaffAuthService) {}

  @Public()
  @Post('login')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: AuthenticatedResponse, description: '12-hour staff session' })
  async login(
    @Body() dto: StaffLoginDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AuthenticatedResponse> {
    return authenticatedResponse(await this.staffAuth.login(dto, meta));
  }

  @Public()
  @Post('activate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: StaffEnrollmentResponse,
    description: 'TOTP secret to add to an authenticator app',
  })
  async activate(
    @Body() dto: StaffActivateDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffEnrollmentResponse> {
    const enrollment = await this.staffAuth.activate(dto, meta);
    return { ...enrollment, expiresAt: enrollment.expiresAt.toISOString() };
  }

  @Public()
  @Post('activate/confirm')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Account active; sign in with password and TOTP' })
  async confirmActivation(
    @Body() dto: StaffActivateConfirmDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.staffAuth.confirmEnrollment(dto, meta);
  }

  @AdminArea()
  @Post('reauthenticate')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Unlocks step-up protected actions for 5 minutes' })
  async reauthenticate(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: StaffReauthenticateDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.staffAuth.reauthenticate(principal, dto.password, dto.totpCode, meta);
  }
}
