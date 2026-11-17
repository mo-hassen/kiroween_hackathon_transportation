import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiCreatedResponse, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import {
  AdminArea,
  RequirePermission,
  RequireRecentAuthentication,
} from '../../../common/auth/authorization.decorators.js';
import { Permission } from '../../../common/auth/permissions.js';
import { CurrentPrincipal, type Principal } from '../../../common/auth/principal.js';
import { validationError } from '../../../common/http/problem-details.js';
import { ReqMeta, type RequestMeta } from '../../../common/http/request-meta.js';
import type { StaffRole } from '../../../generated/prisma/client.js';
import {
  CreateStaffDto,
  GrantRoleDto,
  STAFF_ROLES,
  StaffActivationResponse,
  StaffResponse,
} from './staff.dto.js';
import { StaffAdminService } from './staff-admin.service.js';

const staffIdPipe = new ParseUUIDPipe({ exceptionFactory: () => validationError('id', 'IS_UUID') });

function parseRole(value: string): StaffRole {
  if (!(STAFF_ROLES as string[]).includes(value)) throw validationError('role', 'IS_IN');
  return value as StaffRole;
}

/** /api/v1/admin/staff: customers get 404; staff without the permission get 403. */
@ApiTags('admin: staff')
@AdminArea()
@Controller({ path: 'admin/staff', version: '1' })
export class StaffAdminController {
  constructor(private readonly staff: StaffAdminService) {}

  @Get()
  @RequirePermission(Permission.STAFF_READ)
  @ApiOkResponse({ type: [StaffResponse] })
  list(): Promise<StaffResponse[]> {
    return this.staff.list();
  }

  @Post()
  @RequirePermission(Permission.STAFF_MANAGE)
  @RequireRecentAuthentication()
  @ApiCreatedResponse({ type: StaffActivationResponse })
  create(
    @CurrentPrincipal() actor: Principal,
    @Body() dto: CreateStaffDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffActivationResponse> {
    return this.staff.create(actor, dto, meta);
  }

  @Post(':id/roles')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.STAFF_MANAGE)
  @RequireRecentAuthentication()
  @ApiOkResponse({ type: StaffResponse })
  grantRole(
    @CurrentPrincipal() actor: Principal,
    @Param('id', staffIdPipe) id: string,
    @Body() dto: GrantRoleDto,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffResponse> {
    return this.staff.grantRole(actor, id, dto.role, meta);
  }

  @Delete(':id/roles/:role')
  @RequirePermission(Permission.STAFF_MANAGE)
  @RequireRecentAuthentication()
  @ApiOkResponse({ type: StaffResponse })
  revokeRole(
    @CurrentPrincipal() actor: Principal,
    @Param('id', staffIdPipe) id: string,
    @Param('role') role: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffResponse> {
    return this.staff.revokeRole(actor, id, parseRole(role), meta);
  }

  @Post(':id/credentials/reset')
  @HttpCode(HttpStatus.OK)
  @RequirePermission(Permission.STAFF_MANAGE)
  @RequireRecentAuthentication()
  @ApiOkResponse({ type: StaffActivationResponse })
  resetCredentials(
    @CurrentPrincipal() actor: Principal,
    @Param('id', staffIdPipe) id: string,
    @ReqMeta() meta: RequestMeta,
  ): Promise<StaffActivationResponse> {
    return this.staff.resetCredentials(actor, id, meta);
  }
}
