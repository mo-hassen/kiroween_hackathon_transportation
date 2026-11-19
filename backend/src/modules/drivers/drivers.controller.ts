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
import type { DocumentPurpose } from '../../generated/prisma/client.js';
import { DriversService } from './drivers.service.js';
import {
  AttachDocumentDto,
  DriverProfileDto,
  DriverProfileResponse,
  EligibilityResponse,
  LicenseDetailsDto,
  LicenseResponse,
} from './dto/driver.dto.js';

const idPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });
const PURPOSES: Record<string, DocumentPurpose> = {
  front: 'DRIVER_LICENSE_FRONT',
  back: 'DRIVER_LICENSE_BACK',
};

/** The caller's own driver profile and licence (journey J3). Customers only; staff get 404. */
@ApiTags('drivers')
@ApiBearerAuth()
@Controller({ path: 'drivers/me', version: '1' })
export class DriversController {
  constructor(private readonly drivers: DriversService) {}

  @Post()
  @ApiCreatedResponse({
    type: DriverProfileResponse,
    description: '200 if the profile already exists',
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: DriverProfileDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DriverProfileResponse> {
    const result = await this.drivers.createProfile(principal, dto, meta);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.body;
  }

  @Get()
  @ApiOkResponse({ type: DriverProfileResponse })
  get(@CurrentPrincipal() principal: Principal): Promise<DriverProfileResponse> {
    return this.drivers.profile(principal);
  }

  @Patch()
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The profile `version` you last read',
  })
  @ApiOkResponse({ type: DriverProfileResponse })
  update(
    @CurrentPrincipal() principal: Principal,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: DriverProfileDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<DriverProfileResponse> {
    return this.drivers.updateProfile(principal, ifMatch, dto, meta);
  }

  @Get('eligibility')
  @ApiOkResponse({ type: EligibilityResponse, description: 'Computed by the server on every call' })
  eligibility(@CurrentPrincipal() principal: Principal): Promise<EligibilityResponse> {
    return this.drivers.eligibilityOf(principal);
  }

  @Post('licenses')
  @ApiCreatedResponse({ type: LicenseResponse })
  createLicense(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: LicenseDetailsDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<LicenseResponse> {
    return this.drivers.createLicense(principal, dto, meta);
  }

  @Patch('licenses/:id')
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The licence `version` you last read',
  })
  @ApiOkResponse({ type: LicenseResponse })
  updateLicense(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: LicenseDetailsDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<LicenseResponse> {
    return this.drivers.updateLicense(principal, id, ifMatch, dto, meta);
  }

  @Put('licenses/:id/documents/:side')
  @ApiParam({ name: 'side', enum: ['front', 'back'] })
  @ApiOkResponse({ type: LicenseResponse })
  attach(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @Param('side') side: string,
    @Body() dto: AttachDocumentDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<LicenseResponse> {
    const purpose = PURPOSES[side];
    if (purpose === undefined) throw validationError('side', 'IS_IN');
    return this.drivers.attachDocument(principal, id, purpose, dto.documentId, meta);
  }

  @Post('licenses/:id/submit')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: 'UUID; reuse it when retrying',
  })
  @ApiOkResponse({ type: LicenseResponse })
  async submit(
    @CurrentPrincipal() principal: Principal,
    @Param('id', idPipe) id: string,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<LicenseResponse> {
    const result = await this.drivers.submit(principal, id, key, meta);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
