import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
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
import {
  AttachOwnerDocumentDto,
  CreateOwnerProfileDto,
  OwnerProfileResponse,
  OwnerStatusResponse,
  UpdateOwnerProfileDto,
} from './dto/owner.dto.js';
import { OwnersService } from './owners.service.js';

const SLOTS: Record<string, DocumentPurpose> = {
  tin: 'OWNER_TIN',
  'business-license': 'OWNER_BUSINESS_LICENSE',
  'representative-letter': 'OWNER_REPRESENTATIVE_LETTER',
};

/** The caller's own owner profile (journey J4, FR-4). Customers only; staff get 404. */
@ApiTags('owners')
@ApiBearerAuth()
@Controller({ path: 'owners/me', version: '1' })
export class OwnersController {
  constructor(private readonly owners: OwnersService) {}

  @Post()
  @ApiCreatedResponse({
    type: OwnerProfileResponse,
    description: '200 if the profile already exists',
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateOwnerProfileDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerProfileResponse> {
    const result = await this.owners.createProfile(principal, dto, meta);
    response.status(result.created ? HttpStatus.CREATED : HttpStatus.OK);
    return result.body;
  }

  @Get()
  @ApiOkResponse({ type: OwnerProfileResponse, description: 'The TIN is always masked' })
  get(@CurrentPrincipal() principal: Principal): Promise<OwnerProfileResponse> {
    return this.owners.profile(principal);
  }

  @Patch()
  @ApiHeader({ name: 'If-Match', required: true, description: 'The `version` you last read' })
  @ApiOkResponse({ type: OwnerProfileResponse })
  update(
    @CurrentPrincipal() principal: Principal,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateOwnerProfileDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OwnerProfileResponse> {
    return this.owners.updateProfile(principal, ifMatch, dto, meta);
  }

  @Get('status')
  @ApiOkResponse({ type: OwnerStatusResponse, description: 'Computed by the server on every call' })
  status(@CurrentPrincipal() principal: Principal): Promise<OwnerStatusResponse> {
    return this.owners.statusOf(principal);
  }

  @Put('documents/:slot')
  @ApiParam({ name: 'slot', enum: Object.keys(SLOTS) })
  @ApiOkResponse({ type: OwnerProfileResponse, description: 'Adds or replaces the document' })
  attach(
    @CurrentPrincipal() principal: Principal,
    @Param('slot') slot: string,
    @Body() dto: AttachOwnerDocumentDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<OwnerProfileResponse> {
    const purpose = SLOTS[slot];
    if (purpose === undefined) throw validationError('slot', 'IS_IN');
    return this.owners.attachDocument(principal, purpose, dto.documentId, meta);
  }

  @Post('submit')
  @HttpCode(HttpStatus.OK)
  @ApiHeader({
    name: IDEMPOTENCY_KEY_HEADER,
    required: true,
    description: 'UUID; reuse it when retrying',
  })
  @ApiOkResponse({ type: OwnerProfileResponse })
  async submit(
    @CurrentPrincipal() principal: Principal,
    @IdempotencyKey() key: string,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<OwnerProfileResponse> {
    const result = await this.owners.submit(principal, key, meta);
    if (result.replayed) response.setHeader('Idempotent-Replayed', 'true');
    return result.body;
  }
}
