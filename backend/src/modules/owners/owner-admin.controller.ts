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
import { ApiHeader, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { AdminArea, RequirePermission } from '../../common/auth/authorization.decorators.js';
import { Permission } from '../../common/auth/permissions.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from '../../common/idempotency/idempotency-key.decorator.js';
import { PresignedRequestResponse } from '../documents/dto/document.dto.js';
import { StaffReasonQuery } from '../drivers/dto/driver.dto.js';
import {
  ApproveIndividualDto,
  OrganizationApprovalDto,
  OwnerCaseCountsResponse,
  OwnerCaseDetailResponse,
  OwnerCaseListResponse,
  OwnerCaseSummaryResponse,
  OwnerQueueQuery,
  OwnerReinstateDto,
  OwnerRejectDto,
  OwnerSuspendDto,
  TinCheckDto,
  TinCheckResponse,
} from './dto/owner.dto.js';
import { OwnerReviewService } from './owner-review.service.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });
const KEY_HEADER = {
  name: IDEMPOTENCY_KEY_HEADER,
  required: true,
  description: 'UUID; reuse it when retrying the same decision',
};

function replayed(
  response: Response,
  result: { replayed: boolean; body: OwnerCaseSummaryResponse },
): OwnerCaseSummaryResponse {
  if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

/**
 * /api/v1/admin/owner-verifications: verification officers (owners.review) only. Customers
 * get 404, other staff (including super admins) get 403.
 */
@ApiTags('admin: owner verification')
@AdminArea()
@RequirePermission(Permission.OWNERS_REVIEW)
@Controller({ path: 'admin/owner-verifications', version: '1' })
export class OwnerAdminController {
  constructor(private readonly review: OwnerReviewService) {}

  @Get()
  @ApiOkResponse({ type: OwnerCaseListResponse, description: 'No TIN or document data' })
  list(
    @CurrentPrincipal() officer: Principal,
    @Query() query: OwnerQueueQuery,
  ): Promise<OwnerCaseListResponse> {
    return this.review.list(officer, query);
  }

  // Declared before ':id' so "counts" is not parsed as an id.
  @Get('counts')
  @ApiOkResponse({ type: OwnerCaseCountsResponse })
  counts(): Promise<OwnerCaseCountsResponse> {
    return this.review.counts();
  }

  @Get(':id')
  @ApiOkResponse({ type: OwnerCaseDetailResponse, description: 'Audited; the TIN stays masked' })
  detail(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OwnerCaseDetailResponse> {
    return this.review.detail(officer, id, meta);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse })
  claim(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OwnerCaseSummaryResponse> {
    return this.review.claim(officer, id, meta);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse })
  release(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OwnerCaseSummaryResponse> {
    return this.review.release(officer, id, meta);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse, description: 'Individual owners only' })
  async approve(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: ApproveIndividualDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.approveIndividual(officer, id, dto, key, meta));
  }

  @Post(':id/first-approval')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({
    type: OwnerCaseSummaryResponse,
    description: 'Organizations, step 1 of 2; the owner stays PENDING',
  })
  async firstApproval(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: OrganizationApprovalDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.firstApproval(officer, id, dto, key, meta));
  }

  @Post(':id/second-approval')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({
    type: OwnerCaseSummaryResponse,
    description: 'Organizations, step 2 of 2, by a different officer: VERIFIED',
  })
  async secondApproval(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: OrganizationApprovalDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.secondApproval(officer, id, dto, key, meta));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse })
  async reject(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: OwnerRejectDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.reject(officer, id, dto, key, meta));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse })
  async suspend(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: OwnerSuspendDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.suspend(officer, id, dto, key, meta));
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: OwnerCaseSummaryResponse })
  async reinstate(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: OwnerReinstateDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerCaseSummaryResponse> {
    return replayed(response, await this.review.reinstate(officer, id, dto.note, key, meta));
  }

  @Post(':id/tin-check')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: TinCheckResponse,
    description:
      'Compares the TIN read on the certificate with the stored TIN. Claim holder only; reason required; audited (result only); the stored TIN is never returned',
  })
  tinCheck(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: TinCheckDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<TinCheckResponse> {
    return this.review.tinCheck(officer, id, dto, meta);
  }

  @Get(':id/documents/:documentId/url')
  @ApiOkResponse({
    type: PresignedRequestResponse,
    description: '60-second URL; audited with the reason; claim required while PENDING',
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
