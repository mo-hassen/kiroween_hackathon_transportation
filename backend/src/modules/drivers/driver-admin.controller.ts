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
import { PresignedRequestResponse } from '../documents/dto/document.dto.js';
import { DriverReviewService } from './driver-review.service.js';
import {
  ApproveDto,
  CaseCountsResponse,
  CaseDetailResponse,
  CaseListResponse,
  CaseSummaryResponse,
  ReinstateDto,
  RejectDto,
  ReviewQueueQuery,
  StaffReasonQuery,
  SuspendDto,
} from './dto/driver.dto.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });

/**
 * /api/v1/admin/driver-verifications: verification officers (drivers.review) only. Customers
 * get 404, other staff (including super admins) get 403.
 */
@ApiTags('admin: driver verification')
@AdminArea()
@RequirePermission(Permission.DRIVERS_REVIEW)
@Controller({ path: 'admin/driver-verifications', version: '1' })
export class DriverAdminController {
  constructor(private readonly review: DriverReviewService) {}

  @Get()
  @ApiOkResponse({ type: CaseListResponse })
  list(
    @CurrentPrincipal() officer: Principal,
    @Query() query: ReviewQueueQuery,
  ): Promise<CaseListResponse> {
    return this.review.list(officer, query);
  }

  // Declared before ':id' so "counts" is not parsed as an id.
  @Get('counts')
  @ApiOkResponse({ type: CaseCountsResponse })
  counts(): Promise<CaseCountsResponse> {
    return this.review.counts();
  }

  @Get(':id')
  @ApiOkResponse({
    type: CaseDetailResponse,
    description: 'Includes the full licence number; audited',
  })
  detail(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseDetailResponse> {
    return this.review.detail(officer, id, meta);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  claim(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.claim(officer, id, meta);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  release(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.release(officer, id, meta);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  approve(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: ApproveDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.approve(officer, id, dto, meta);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  reject(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: RejectDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.reject(officer, id, dto, meta);
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  suspend(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: SuspendDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.suspend(officer, id, dto, meta);
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: CaseSummaryResponse })
  reinstate(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: ReinstateDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<CaseSummaryResponse> {
    return this.review.reinstate(officer, id, dto.note, meta);
  }

  @Get(':id/documents/:documentId/url')
  @ApiOkResponse({
    type: PresignedRequestResponse,
    description: '60-second URL; audited with the reason',
  })
  async documentUrl(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Param('documentId', idPipe) documentId: string,
    @Query() query: StaffReasonQuery,
    @ReqMeta() meta: RequestMeta,
  ): Promise<PresignedRequestResponse> {
    const request = await this.review.documentUrl(officer, id, documentId, query.reason, meta);
    return {
      ...request,
      headers: { ...request.headers },
      expiresAt: request.expiresAt.toISOString(),
    };
  }
}
