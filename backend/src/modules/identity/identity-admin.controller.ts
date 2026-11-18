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
} from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { AdminArea, RequirePermission } from '../../common/auth/authorization.decorators.js';
import { Permission } from '../../common/auth/permissions.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import {
  AdminVerificationResponse,
  StaffActionResponse,
  StaffReasonDto,
  StaffReasonQuery,
} from './dto/identity.dto.js';
import { IdentityAdminService, type StaffActionResult } from './identity-admin.service.js';

const verificationIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => validationError('id', 'IS_UUID'),
});

/** /api/v1/admin/identity-verifications: verification officers (identity.review) only. */
@ApiTags('admin: identity')
@AdminArea()
@RequirePermission(Permission.IDENTITY_REVIEW)
@Controller({ path: 'admin/identity-verifications', version: '1' })
export class IdentityAdminController {
  constructor(private readonly admin: IdentityAdminService) {}

  @Get(':id')
  @ApiOkResponse({ type: AdminVerificationResponse, description: 'Audited with the reason' })
  view(
    @CurrentPrincipal() actor: Principal,
    @Param('id', verificationIdPipe) id: string,
    @Query() query: StaffReasonQuery,
    @ReqMeta() meta: RequestMeta,
  ): Promise<AdminVerificationResponse> {
    return this.admin.view(actor, id, query.reason, meta);
  }

  @Post(':id/require-reverification')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StaffActionResponse })
  requireReverification(
    @CurrentPrincipal() actor: Principal,
    @Param('id', verificationIdPipe) id: string,
    @Body() dto: StaffReasonDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffActionResult> {
    return this.admin.requireReverification(actor, id, dto.reason, meta);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: StaffActionResponse })
  suspend(
    @CurrentPrincipal() actor: Principal,
    @Param('id', verificationIdPipe) id: string,
    @Body() dto: StaffReasonDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffActionResult> {
    return this.admin.suspend(actor, id, dto.reason, meta);
  }
}
