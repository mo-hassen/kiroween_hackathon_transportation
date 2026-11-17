import type { StaffRole } from '../../generated/prisma/client.js';
import { bearerToken, buildIpAllowlist } from './authentication.guard.js';
import { decideAuthorization, RECENT_AUTHENTICATION_MAX_AGE_MS } from './authorization.guard.js';
import { hasPermission, Permission, permissionsFor, ROLE_PERMISSIONS } from './permissions.js';
import { assertVisible, ownedByPrincipal } from './policy.js';
import type { Principal } from './principal.js';

const NOW = new Date('2026-11-17T12:00:00Z');

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'u-1',
    sessionId: 's-1',
    accountType: 'CUSTOMER',
    status: 'ACTIVE',
    roles: [],
    authenticatedAt: NOW,
    ...overrides,
  };
}
const staff = (roles: StaffRole[], authenticatedAt = NOW): Principal =>
  principal({ accountType: 'STAFF', roles, authenticatedAt });

describe('role -> permission map (separation of duties)', () => {
  it('lets only super admins manage staff', () => {
    for (const role of Object.keys(ROLE_PERMISSIONS) as StaffRole[]) {
      expect(hasPermission([role], Permission.STAFF_MANAGE)).toBe(role === 'SUPER_ADMIN');
    }
  });

  it('lets only verification officers verify vehicles, documents and identity', () => {
    for (const permission of [
      Permission.VEHICLES_VERIFY,
      Permission.DOCUMENTS_REVIEW,
      Permission.IDENTITY_REVIEW,
    ]) {
      for (const role of Object.keys(ROLE_PERMISSIONS) as StaffRole[]) {
        expect(hasPermission([role], permission)).toBe(role === 'VERIFICATION_OFFICER');
      }
    }
  });

  it('lets only finance move payouts, and keeps propose/approve with different roles (four-eyes)', () => {
    expect(
      (Object.keys(ROLE_PERMISSIONS) as StaffRole[]).filter((r) =>
        hasPermission([r], Permission.PAYOUTS_MANAGE),
      ),
    ).toEqual(['FINANCE']);
    for (const [propose, approve] of [
      [Permission.ADJUSTMENTS_PROPOSE, Permission.ADJUSTMENTS_APPROVE],
      [Permission.COMMISSION_RULES_PROPOSE, Permission.COMMISSION_RULES_APPROVE],
    ] as const) {
      for (const role of Object.keys(ROLE_PERMISSIONS) as StaffRole[]) {
        expect(hasPermission([role], propose) && hasPermission([role], approve)).toBe(false);
      }
    }
  });

  it('gives finance no user or staff administration', () => {
    const finance = permissionsFor(['FINANCE']);
    expect(finance.has(Permission.USERS_SUSPEND)).toBe(false);
    expect(finance.has(Permission.STAFF_READ)).toBe(false);
  });

  it('gives no permissions to an empty role list', () => {
    expect(permissionsFor([]).size).toBe(0);
  });
});

describe('decideAuthorization', () => {
  const rules = (overrides: Partial<Parameters<typeof decideAuthorization>[1]> = {}) => ({
    adminArea: false,
    permission: undefined,
    recentAuthentication: false,
    ...overrides,
  });

  it.each([
    ['customer on an admin area', principal(), rules({ adminArea: true }), 'NOT_FOUND'],
    [
      'customer on a permission route',
      principal(),
      rules({ permission: Permission.STAFF_READ }),
      'NOT_FOUND',
    ],
    [
      'staff without the permission',
      staff(['FINANCE']),
      rules({ permission: Permission.STAFF_READ }),
      'FORBIDDEN',
    ],
    [
      'staff with no roles',
      staff([]),
      rules({ adminArea: true, permission: Permission.STAFF_READ }),
      'FORBIDDEN',
    ],
    [
      'staff with the permission',
      staff(['SUPER_ADMIN']),
      rules({ permission: Permission.STAFF_READ }),
      'ALLOW',
    ],
    ['customer on a normal route', principal(), rules(), 'ALLOW'],
    ['staff on a normal route', staff(['SUPPORT']), rules(), 'ALLOW'],
  ] as const)('%s -> %s', (_label, who, rule, expected) => {
    expect(decideAuthorization(who, rule, NOW)).toBe(expected);
  });

  it('requires a recent authentication for step-up routes', () => {
    const fresh = staff(
      ['SUPER_ADMIN'],
      new Date(NOW.getTime() - RECENT_AUTHENTICATION_MAX_AGE_MS + 1000),
    );
    const stale = staff(
      ['SUPER_ADMIN'],
      new Date(NOW.getTime() - RECENT_AUTHENTICATION_MAX_AGE_MS - 1000),
    );
    const rule = rules({ permission: Permission.STAFF_MANAGE, recentAuthentication: true });
    expect(decideAuthorization(fresh, rule, NOW)).toBe('ALLOW');
    expect(decideAuthorization(stale, rule, NOW)).toBe('REAUTHENTICATE');
  });
});

describe('resource policies', () => {
  it('returns the resource when the caller owns it', () => {
    expect(assertVisible(principal(), { userId: 'u-1', id: 's' }, ownedByPrincipal)).toEqual({
      userId: 'u-1',
      id: 's',
    });
  });

  it.each([
    ['another user', { userId: 'u-2' }],
    ['a missing resource', null],
  ])('reports %s as NOT_FOUND', (_label, resource) => {
    expect(() => assertVisible(principal(), resource, ownedByPrincipal)).toThrow(
      expect.objectContaining({ code: 'NOT_FOUND', status: 404 }),
    );
  });
});

describe('bearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc.def.ghi', 'abc.def.ghi'],
    ['Basic dXNlcjpwYXNz', null],
    ['Bearer', null],
    ['Bearer a b', null],
    [undefined, null],
  ])('%j -> %j', (header, expected) => {
    expect(bearerToken(header)).toBe(expected);
  });
});

describe('buildIpAllowlist', () => {
  it('matches addresses and subnets for IPv4 and IPv6', () => {
    const list = buildIpAllowlist(['10.0.0.0/8', '192.168.1.10', '2001:db8::/32']);
    expect(list?.check('10.1.2.3', 'ipv4')).toBe(true);
    expect(list?.check('192.168.1.10', 'ipv4')).toBe(true);
    expect(list?.check('192.168.1.11', 'ipv4')).toBe(false);
    expect(list?.check('2001:db8::1', 'ipv6')).toBe(true);
  });

  it('is disabled when empty', () => {
    expect(buildIpAllowlist([])).toBeNull();
  });
});
