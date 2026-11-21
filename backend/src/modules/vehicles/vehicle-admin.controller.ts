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
  ApproveVehicleDto,
  ReinstateVehicleDto,
  RejectVehicleDto,
  SuspendVehicleDto,
  VehicleCaseCountsResponse,
  VehicleCaseDetailResponse,
  VehicleCaseListResponse,
  VehicleCaseSummaryResponse,
  VehicleQueueQuery,
} from './dto/vehicle.dto.js';
import { VehicleReviewService } from './vehicle-review.service.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });
const KEY_HEADER = {
  name: IDEMPOTENCY_KEY_HEADER,
  required: true,
  description: 'UUID; reuse it when retrying the same decision',
};

function replayed(
  response: Response,
  result: { replayed: boolean; body: VehicleCaseSummaryResponse },
): VehicleCaseSummaryResponse {
  if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
  return result.body;
}

/**
 * /api/v1/admin/vehicle-verifications: verification officers (vehicles.verify) only. Customers
 * get 404, other staff (including super admins) get 403.
 */
@ApiTags('admin: vehicle verification')
@AdminArea()
@RequirePermission(Permission.VEHICLES_VERIFY)
@Controller({ path: 'admin/vehicle-verifications', version: '1' })
export class VehicleAdminController {
  constructor(private readonly review: VehicleReviewService) {}

  @Get()
  @ApiOkResponse({ type: VehicleCaseListResponse, description: 'No VIN or document data' })
  list(
    @CurrentPrincipal() officer: Principal,
    @Query() query: VehicleQueueQuery,
  ): Promise<VehicleCaseListResponse> {
    return this.review.list(officer, query);
  }

  // Declared before ':id' so "counts" is not parsed as an id.
  @Get('counts')
  @ApiOkResponse({ type: VehicleCaseCountsResponse })
  counts(): Promise<VehicleCaseCountsResponse> {
    return this.review.counts();
  }

  @Get(':id')
  @ApiOkResponse({
    type: VehicleCaseDetailResponse,
    description: 'Audited. The full VIN is shown only to the officer holding the claim',
  })
  detail(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleCaseDetailResponse> {
    return this.review.detail(officer, id, meta);
  }

  @Post(':id/claim')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  claim(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleCaseSummaryResponse> {
    return this.review.claim(officer, id, meta);
  }

  @Post(':id/release')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  release(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleCaseSummaryResponse> {
    return this.review.release(officer, id, meta);
  }

  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  async approve(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: ApproveVehicleDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleCaseSummaryResponse> {
    return replayed(response, await this.review.approve(officer, id, dto, key, meta));
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  async reject(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: RejectVehicleDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleCaseSummaryResponse> {
    return replayed(response, await this.review.reject(officer, id, dto, key, meta));
  }

  @Post(':id/suspend')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  async suspend(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: SuspendVehicleDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleCaseSummaryResponse> {
    return replayed(response, await this.review.suspend(officer, id, dto, key, meta));
  }

  @Post(':id/reinstate')
  @HttpCode(HttpStatus.OK)
  @ApiHeader(KEY_HEADER)
  @ApiOkResponse({ type: VehicleCaseSummaryResponse })
  async reinstate(
    @CurrentPrincipal() officer: Principal,
    @Param('id', idPipe) id: string,
    @Body() dto: ReinstateVehicleDto,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleCaseSummaryResponse> {
    return replayed(response, await this.review.reinstate(officer, id, dto.note, key, meta));
  }

  @Get(':id/documents/:documentId/url')
  @ApiOkResponse({
    type: PresignedRequestResponse,
    description: '60-second URL; audited with the reason; claim required while the case is open',
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
