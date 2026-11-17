import type { INestApplicationContext } from '@nestjs/common';
import { AuditService } from '../common/audit/audit.service.js';
import { PrismaService } from '../infrastructure/prisma/prisma.service.js';
import type { Activation } from '../modules/admin/staff/staff-provisioning.service.js';
import { StaffProvisioningService } from '../modules/admin/staff/staff-provisioning.service.js';

export type BootstrapResult =
  | { readonly kind: 'CREATED'; readonly userId: string; readonly activation: Activation }
  | { readonly kind: 'ALREADY_BOOTSTRAPPED' };

/**
 * Creates the first super administrator, at most once: an advisory lock serializes
 * concurrent runs, and any existing SUPER_ADMIN grant (active or revoked) stops it.
 */
export async function bootstrapSuperAdmin(
  app: INestApplicationContext,
  input: { phoneE164: string; displayName: string },
): Promise<BootstrapResult> {
  const prisma = app.get(PrismaService);
  const provisioning = app.get(StaffProvisioningService);
  const audit = app.get(AuditService);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT 1 AS locked FROM (SELECT pg_advisory_xact_lock(hashtext('bootstrap-super-admin'))) AS l`;
    if ((await tx.staffRoleAssignment.count({ where: { role: 'SUPER_ADMIN' } })) > 0) {
      return { kind: 'ALREADY_BOOTSTRAPPED' };
    }
    const created = await provisioning.createStaff(tx, {
      phoneE164: input.phoneE164,
      displayName: input.displayName,
      roles: ['SUPER_ADMIN'],
      grantedById: null,
    });
    await audit.record(tx, {
      actor: { type: 'SYSTEM' },
      action: 'staff.bootstrapped',
      target: { type: 'user', id: created.userId },
      changes: { roles: ['SUPER_ADMIN'] },
    });
    return { kind: 'CREATED', ...created };
  });
}
