import { applyDecorators, SetMetadata } from '@nestjs/common';
import { ApiBearerAuth } from '@nestjs/swagger';
import type { Permission } from './permissions.js';

export const ADMIN_AREA = 'authz:admin-area';
export const REQUIRED_PERMISSION = 'authz:permission';
export const RECENT_AUTHENTICATION = 'authz:recent-authentication';
export const ALLOW_RESTRICTED_ACCOUNT = 'authz:allow-restricted';

/** Staff-only controller. Any non-staff caller gets 404, so the admin surface is not revealed. */
export const AdminArea = (): ClassDecorator & MethodDecorator =>
  applyDecorators(SetMetadata(ADMIN_AREA, true), ApiBearerAuth());

/** Staff without this permission get 403. Implies AdminArea semantics for non-staff (404). */
export const RequirePermission = (permission: Permission): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_PERMISSION, permission);

/** Staff must have re-entered password + TOTP within the last few minutes (step-up). */
export const RequireRecentAuthentication = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RECENT_AUTHENTICATION, true);

/**
 * Allows a SUSPENDED/LOCKED account to call a state-changing route (BR-ACC-3 exceptions,
 * e.g. revoking its own sessions). By default such accounts are read-only.
 */
export const AllowRestrictedAccount = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_RESTRICTED_ACCOUNT, true);
