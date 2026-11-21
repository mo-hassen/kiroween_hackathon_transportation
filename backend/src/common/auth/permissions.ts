import type { StaffRole } from '../../generated/prisma/client.js';

/**
 * Staff permissions (docs/architecture/01-requirements-actors-journeys.md §4).
 *
 * The role -> permission map is code, reviewed in pull requests, not data. Phase 3 wires
 * `staff.read` and `staff.manage`; the remaining permissions are declared now so that
 * separation of duties is fixed and tested before the endpoints that use them exist.
 * Customer capabilities (driver, owner) come from profiles and their state, not roles.
 */
export const Permission = {
  STAFF_READ: 'staff.read',
  STAFF_MANAGE: 'staff.manage',
  AUDIT_READ: 'audit.read',
  USERS_READ: 'users.read',
  USERS_SUSPEND: 'users.suspend',
  IDENTITY_REVIEW: 'identity.review',
  DOCUMENTS_REVIEW: 'documents.review',
  // Phase 5: driver licence cases (queue, claim, decisions) and their documents.
  DRIVERS_REVIEW: 'drivers.review',
  // Phase 6: owner verification cases (queue, claim, four-eyes decisions) and their documents.
  OWNERS_REVIEW: 'owners.review',
  VEHICLES_VERIFY: 'vehicles.verify',
  SUPPORT_TICKETS_MANAGE: 'support_tickets.manage',
  DISPUTES_MANAGE: 'disputes.manage',
  LEDGER_READ: 'ledger.read',
  PAYOUTS_MANAGE: 'payouts.manage',
  ADJUSTMENTS_PROPOSE: 'adjustments.propose',
  ADJUSTMENTS_APPROVE: 'adjustments.approve',
  COMMISSION_RULES_PROPOSE: 'commission_rules.propose',
  COMMISSION_RULES_APPROVE: 'commission_rules.approve',
  CONFIG_MANAGE: 'config.manage',
} as const;
export type Permission = (typeof Permission)[keyof typeof Permission];

export const ROLE_PERMISSIONS: Readonly<Record<StaffRole, readonly Permission[]>> = Object.freeze({
  SUPPORT: [
    Permission.USERS_READ,
    Permission.USERS_SUSPEND,
    Permission.SUPPORT_TICKETS_MANAGE,
    Permission.DISPUTES_MANAGE,
  ],
  VERIFICATION_OFFICER: [
    Permission.USERS_READ,
    Permission.USERS_SUSPEND,
    Permission.IDENTITY_REVIEW,
    Permission.DOCUMENTS_REVIEW,
    Permission.DRIVERS_REVIEW,
    Permission.OWNERS_REVIEW,
    Permission.VEHICLES_VERIFY,
  ],
  FINANCE: [
    Permission.LEDGER_READ,
    Permission.PAYOUTS_MANAGE,
    Permission.ADJUSTMENTS_PROPOSE,
    Permission.COMMISSION_RULES_PROPOSE,
  ],
  // Super admins manage staff and approve four-eyes changes, but cannot verify
  // documents/vehicles or move payouts themselves.
  SUPER_ADMIN: [
    Permission.STAFF_READ,
    Permission.STAFF_MANAGE,
    Permission.AUDIT_READ,
    Permission.USERS_READ,
    Permission.USERS_SUSPEND,
    Permission.SUPPORT_TICKETS_MANAGE,
    Permission.DISPUTES_MANAGE,
    Permission.LEDGER_READ,
    Permission.ADJUSTMENTS_APPROVE,
    Permission.COMMISSION_RULES_APPROVE,
    Permission.CONFIG_MANAGE,
  ],
});

export function permissionsFor(roles: readonly StaffRole[]): ReadonlySet<Permission> {
  return new Set(roles.flatMap((role) => ROLE_PERMISSIONS[role]));
}

export function hasPermission(roles: readonly StaffRole[], permission: Permission): boolean {
  return roles.some((role) => ROLE_PERMISSIONS[role].includes(permission));
}
