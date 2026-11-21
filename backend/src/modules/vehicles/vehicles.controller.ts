import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import {
  IdempotencyKey,
  IDEMPOTENCY_KEY_HEADER,
} from '../../common/idempotency/idempotency-key.decorator.js';
import type { VehicleEvidenceSlot } from '../../generated/prisma/client.js';
import {
  AttachVehicleEvidenceDto,
  CreateVehicleDto,
  UpdateVehicleDto,
  VehicleListResponse,
  VehicleResponse,
  VehicleStatusResponse,
} from './dto/vehicle.dto.js';
import { EVIDENCE_SLOTS } from './vehicle-rules.js';
import { VehiclesService } from './vehicles.service.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });

/** The caller's own vehicles (journey J5, FR-5). Customers only; staff get 404. */
@ApiTags('vehicles')
@ApiBearerAuth()
@Controller({ path: 'vehicles', version: '1' })
export class VehiclesController {
  constructor(private readonly vehicles: VehiclesService) {}

  @Post()
  @ApiCreatedResponse({
    type: VehicleResponse,
    description:
      '201. Needs a VERIFIED owner profile (409 OWNER_NOT_VERIFIED). 200 when the same draft already exists',
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateVehicleDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleResponse> {
    const result = await this.vehicles.create(principal, dto, meta);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.body;
  }

  @Get()
  @ApiOkResponse({ type: VehicleListResponse, description: 'The caller’s vehicles, not archived' })
  list(@CurrentPrincipal() principal: Principal): Promise<VehicleListResponse> {
    return this.vehicles.list(principal);
  }

  @Get(':id')
  @ApiOkResponse({ type: VehicleResponse, description: 'The VIN is always masked' })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
  ): Promise<VehicleResponse> {
    return this.vehicles.get(principal, id);
  }

  @Patch(':id')
  @ApiHeader({ name: 'If-Match', required: true, description: 'The `version` you last read' })
  @ApiOkResponse({
    type: VehicleResponse,
    description:
      'Editable in DRAFT, REJECTED, EXPIRED (returns to DRAFT). On an APPROVED vehicle, a change to make, model, year, type, plate, VIN or engine number sends it back to SUBMITTED',
  })
  update(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateVehicleDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleResponse> {
    return this.vehicles.update(principal, id, ifMatch, dto, meta);
  }

  @Put(':id/evidence/:slot')
  @ApiParam({ name: 'slot', enum: EVIDENCE_SLOTS })
  @ApiOkResponse({
    type: VehicleResponse,
    description:
      'Adds or replaces a document or photo. On an APPROVED vehicle this sends it back to SUBMITTED',
  })
  attach(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @Param('slot') slot: string,
    @Body() dto: AttachVehicleEvidenceDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleResponse> {
    if (!(EVIDENCE_SLOTS as readonly string[]).includes(slot))
      throw validationError('slot', 'IS_IN');
    return this.vehicles.attachEvidence(principal, id, slot as VehicleEvidenceSlot, dto, meta);
  }

  @Get(':id/status')
  @ApiOkResponse({
    type: VehicleStatusResponse,
    description: 'Computed by the server on every call',
  })
  status(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
  ): Promise<VehicleStatusResponse> {
    return this.vehicles.statusOf(principal, id);
  }

  @Post(':id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: 'UUID; reuse it when retrying',
  })
  @ApiOkResponse({
    type: VehicleResponse,
    description: '422 VEHICLE_SUBMISSION_INCOMPLETE lists the blockers',
  })
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VehicleResponse> {
    const result = await this.vehicles.submit(principal, id, key, meta);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: VehicleResponse,
    description: 'Not allowed while SUBMITTED, UNDER_REVIEW or SUSPENDED. Repeating it is harmless',
  })
  archive(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<VehicleResponse> {
    return this.vehicles.archive(principal, id, meta);
  }
}
