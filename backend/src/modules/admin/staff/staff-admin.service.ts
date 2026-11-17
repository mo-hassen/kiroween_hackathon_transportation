import { HttpStatus, Injectable } from '@nestjs/common';
import type { Principal } from '../../../common/auth/principal.js';
import { AuditService } from '../../../common/audit/audit.service.js';
import { DomainError, ErrorCode } from '../../../common/http/problem-details.js';
import type { RequestMeta } from '../../../common/http/request-meta.js';
import type { Prisma, StaffRole } from '../../../generated/prisma/client.js';
import { PrismaService } from '../../../infrastructure/prisma/prisma.service.js';
import { isUniqueViolation } from '../../auth/auth-errors.js';
import { UNUSABLE_PASSWORD_HASH } from '../../auth/password/password.service.js';
import { SessionService } from '../../auth/sessions/session.service.js';
import type { CreateStaffDto, StaffActivationResponse, StaffResponse } from './staff.dto.js';
import { StaffProvisioningService } from './staff-provisioning.service.js';

const STAFF_SELECT = {
  id: true,
  phoneE164: true,
  displayName: true,
  status: true,
  mfaEnrolledAt: true,
  createdAt: true,
  staffRoles: {
    where: { revokedAt: null },
    select: { role: true, grantedAt: true },
    orderBy: { role: 'asc' },
  },
} as const satisfies Prisma.UserSelect;

type StaffRow = Prisma.UserGetPayload<{ select: typeof STAFF_SELECT }>;

function toResponse(row: StaffRow): StaffResponse {
  return {
    id: row.id,
    phone: row.phoneE164,
    displayName: row.displayName,
    status: row.status,
    mfaEnrolled: row.mfaEnrolledAt !== null,
    roles: row.staffRoles.map((r) => ({ role: r.role, grantedAt: r.grantedAt.toISOString() })),
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Staff and role management (super administrators only; enforced by the controller's
 * permission and step-up decorators). Nobody can change their own staff access, and the
 * last super administrator cannot be removed. Every change is audited.
 */
@Injectable()
export class StaffAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provisioning: StaffProvisioningService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
  ) {}

  async list(): Promise<StaffResponse[]> {
    const rows = await this.prisma.user.findMany({
      where: { accountType: 'STAFF' },
      orderBy: { createdAt: 'asc' },
      select: STAFF_SELECT,
    });
    return rows.map(toResponse);
  }

  async create(
    actor: Principal,
    dto: CreateStaffDto,
    meta: RequestMeta,
  ): Promise<StaffActivationResponse> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const { userId, activation } = await this.provisioning.createStaff(tx, {
          phoneE164: dto.phone,
          displayName: dto.displayName,
          roles: dto.roles,
          grantedById: actor.userId,
        });
        await this.audit.record(tx, {
          actor: { type: 'STAFF', userId: actor.userId },
          action: 'staff.created',
          target: { type: 'user', id: userId },
          changes: { roles: [...dto.roles] },
          meta,
        });
        const row = await tx.user.findUniqueOrThrow({
          where: { id: userId },
          select: STAFF_SELECT,
        });
        return {
          staff: toResponse(row),
          activationCode: activation.code,
          activationExpiresAt: activation.expiresAt.toISOString(),
        };
      });
    } catch (error) {
      if (isUniqueViolation(error))
        throw new DomainError(ErrorCode.PHONE_IN_USE, HttpStatus.CONFLICT);
      throw error;
    }
  }

  async grantRole(
    actor: Principal,
    staffId: string,
    role: StaffRole,
    meta: RequestMeta,
  ): Promise<StaffResponse> {
    this.assertNotSelf(actor, staffId);
    return this.prisma.$transaction(async (tx) => {
      await this.findStaff(tx, staffId);
      await tx.staffRoleAssignment.upsert({
        where: { userId_role: { userId: staffId, role } },
        create: { userId: staffId, role, grantedById: actor.userId },
        update: {
          revokedAt: null,
          revokedById: null,
          grantedById: actor.userId,
          grantedAt: new Date(),
        },
      });
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: actor.userId },
        action: 'staff.role_granted',
        target: { type: 'user', id: staffId },
        changes: { role },
        meta,
      });
      return toResponse(await this.findStaff(tx, staffId));
    });
  }

  async revokeRole(
    actor: Principal,
    staffId: string,
    role: StaffRole,
    meta: RequestMeta,
  ): Promise<StaffResponse> {
    this.assertNotSelf(actor, staffId);
    return this.prisma.$transaction(async (tx) => {
      await this.findStaff(tx, staffId);
      if (role === 'SUPER_ADMIN') await this.assertAnotherSuperAdminRemains(tx, staffId);
      const revoked = await tx.staffRoleAssignment.updateMany({
        where: { userId: staffId, role, revokedAt: null },
        data: { revokedAt: new Date(), revokedById: actor.userId },
      });
      if (revoked.count === 0) throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: actor.userId },
        action: 'staff.role_revoked',
        target: { type: 'user', id: staffId },
        changes: { role },
        meta,
      });
      return toResponse(await this.findStaff(tx, staffId));
    });
  }

  /** Lost password or authenticator: back to PENDING_ACTIVATION with a new one-time code. */
  async resetCredentials(
    actor: Principal,
    staffId: string,
    meta: RequestMeta,
  ): Promise<StaffActivationResponse> {
    this.assertNotSelf(actor, staffId);
    return this.prisma.$transaction(async (tx) => {
      const staff = await this.findStaff(tx, staffId);
      await tx.user.update({
        where: { id: staffId },
        data: {
          status: 'PENDING_ACTIVATION',
          passwordHash: UNUSABLE_PASSWORD_HASH,
          mfaSecretEnc: null,
          mfaEnrolledAt: null,
          mfaLastUsedStep: null,
          failedLoginCount: 0,
          lockedUntil: null,
        },
      });
      const revoked = await this.sessions.revokeAllForUser(tx, staffId, 'CREDENTIALS_RESET');
      const activation = await this.provisioning.issueActivation(tx, staffId, staff.phoneE164);
      await this.audit.record(tx, {
        actor: { type: 'STAFF', userId: actor.userId },
        action: 'staff.credentials_reset',
        target: { type: 'user', id: staffId },
        changes: {
          status: { from: staff.status, to: 'PENDING_ACTIVATION' },
          sessionsRevoked: revoked,
        },
        meta,
      });
      return {
        staff: toResponse(await this.findStaff(tx, staffId)),
        activationCode: activation.code,
        activationExpiresAt: activation.expiresAt.toISOString(),
      };
    });
  }

  private assertNotSelf(actor: Principal, staffId: string): void {
    if (actor.userId === staffId) {
      throw new DomainError(ErrorCode.CANNOT_MODIFY_OWN_ACCOUNT, HttpStatus.FORBIDDEN);
    }
  }

  private async findStaff(tx: Prisma.TransactionClient, staffId: string): Promise<StaffRow> {
    const row = await tx.user.findFirst({
      where: { id: staffId, accountType: 'STAFF' },
      select: STAFF_SELECT,
    });
    if (row === null) throw new DomainError(ErrorCode.NOT_FOUND, HttpStatus.NOT_FOUND);
    return row;
  }

  private async assertAnotherSuperAdminRemains(
    tx: Prisma.TransactionClient,
    staffId: string,
  ): Promise<void> {
    // Lock the active super-admin rows so two concurrent revocations cannot remove both.
    const remaining = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT a.user_id FROM staff_role_assignments a
      JOIN users u ON u.id = a.user_id
      WHERE a.role = 'SUPER_ADMIN' AND a.revoked_at IS NULL AND u.status = 'ACTIVE' AND a.user_id <> ${staffId}::uuid
      FOR UPDATE OF a`;
    if (remaining.length === 0)
      throw new DomainError(ErrorCode.LAST_SUPER_ADMIN, HttpStatus.CONFLICT);
  }
}
