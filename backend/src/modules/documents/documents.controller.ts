import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiBearerAuth, ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import { DocumentsService } from './documents.service.js';
import {
  CreateUploadIntentDto,
  DocumentResponse,
  PresignedRequestResponse,
  UploadIntentResponse,
} from './dto/document.dto.js';

const documentIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => validationError('id', 'IS_UUID'),
});

/** The caller's own private documents. Another user's document id is always 404. */
@ApiTags('documents')
@ApiBearerAuth()
@Controller({ path: 'documents', version: '1' })
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @ApiCreatedResponse({
    type: UploadIntentResponse,
    description: 'Upload with the 5-minute PUT URL',
  })
  createIntent(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: CreateUploadIntentDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<UploadIntentResponse> {
    return this.documents.createUploadIntent(principal, dto, meta);
  }

  @Get(':id')
  @ApiOkResponse({ type: DocumentResponse })
  get(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentIdPipe) id: string,
  ): Promise<DocumentResponse> {
    return this.documents.get(principal, id);
  }

  @Post(':id/complete')
  @HttpCode(HttpStatus.OK)
  @ApiOkResponse({
    type: DocumentResponse,
    description: 'Validates, re-encodes and scans the upload; AVAILABLE only if all checks pass',
  })
  complete(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentIdPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<DocumentResponse> {
    return this.documents.complete(principal, id, meta);
  }

  @Get(':id/url')
  @ApiOkResponse({ type: PresignedRequestResponse, description: '60-second download URL' })
  async url(
    @CurrentPrincipal() principal: Principal,
    @Param('id', documentIdPipe) id: string,
  ): Promise<PresignedRequestResponse> {
    const request = await this.documents.downloadUrl(principal, id);
    return {
      ...request,
      headers: { ...request.headers },
      expiresAt: request.expiresAt.toISOString(),
    };
  }
}
