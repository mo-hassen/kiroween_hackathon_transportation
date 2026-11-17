import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AllowRestrictedAccount } from '../../common/auth/authorization.decorators.js';
import { CurrentPrincipal, type Principal } from '../../common/auth/principal.js';
import { validationError } from '../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../common/http/request-meta.js';
import { ChangePasswordDto, MeResponse, SessionResponse, UpdateMeDto } from './me.dto.js';
import { MeService } from './me.service.js';

const sessionIdPipe = new ParseUUIDPipe({
  exceptionFactory: () => validationError('id', 'IS_UUID'),
});

@ApiTags('me')
@ApiBearerAuth()
@Controller({ path: 'me', version: '1' })
export class MeController {
  constructor(private readonly me: MeService) {}

  @Get()
  @ApiOkResponse({ type: MeResponse })
  async get(
    @CurrentPrincipal() principal: Principal,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const me = await this.me.get(principal);
    response.setHeader('ETag', String(me.version));
    return me;
  }

  @Patch()
  @ApiHeader({ name: 'If-Match', required: true, description: 'The `version` you last read' })
  @ApiOkResponse({ type: MeResponse })
  async update(
    @CurrentPrincipal() principal: Principal,
    @Headers('if-match') ifMatch: string | undefined,
    @Body() dto: UpdateMeDto,
    @ReqMeta() meta: RequestMeta,
    @Res({ passthrough: true }) response: Response,
  ): Promise<MeResponse> {
    const me = await this.me.update(principal, ifMatch, dto, meta);
    response.setHeader('ETag', String(me.version));
    return me;
  }

  @Get('sessions')
  @ApiOkResponse({ type: [SessionResponse] })
  sessions(@CurrentPrincipal() principal: Principal): Promise<SessionResponse[]> {
    return this.me.listSessions(principal);
  }

  @Delete('sessions/:id')
  @AllowRestrictedAccount()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Session ended (signing out a device)' })
  async revokeSession(
    @CurrentPrincipal() principal: Principal,
    @Param('id', sessionIdPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.me.revokeSession(principal, id, meta);
  }

  @Post('password')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({ description: 'Password changed; other sessions ended' })
  async changePassword(
    @CurrentPrincipal() principal: Principal,
    @Body() dto: ChangePasswordDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<void> {
    await this.me.changePassword(principal, dto, meta);
  }
}
