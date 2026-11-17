import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  type KeyObject,
  randomUUID,
} from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import type { AccountType, StaffRole } from '../../generated/prisma/client.js';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
export const TOKEN_ISSUER = 'kiroween-mobility';
export const TOKEN_AUDIENCE = 'mobility-api';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AccessTokenClaims {
  readonly userId: string;
  readonly sessionId: string;
  readonly accountType: AccountType;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

const TYP_FOR: Record<AccountType, string> = { CUSTOMER: 'customer', STAFF: 'staff' };

/**
 * Short-lived EdDSA (Ed25519) access tokens. The token only identifies the session; the
 * guard re-checks the session, account status and roles in the database on every request.
 */
@Injectable()
export class AccessTokenService {
  private readonly logger = new Logger('AccessTokens');
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  private readonly keyId: string;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    if (config.auth.jwtPrivateKeyPem === undefined) {
      if (config.isDeployed)
        throw new Error('AUTH_JWT_PRIVATE_KEY is required outside development');
      // Development/test only: tokens become invalid on restart; clients just refresh.
      this.privateKey = generateKeyPairSync('ed25519').privateKey;
      this.keyId = `ephemeral-${randomUUID().slice(0, 8)}`;
      this.logger.warn('Using an ephemeral JWT signing key (development/test only)');
    } else {
      this.privateKey = createPrivateKey(config.auth.jwtPrivateKeyPem);
      this.keyId = config.auth.jwtKeyId;
    }
    this.publicKey = createPublicKey(this.privateKey);
  }

  async issue(
    claims: AccessTokenClaims,
    roles: readonly StaffRole[] = [],
  ): Promise<IssuedAccessToken> {
    const expiresAt = new Date((Math.floor(Date.now() / 1000) + ACCESS_TOKEN_TTL_SECONDS) * 1000);
    const token = await new SignJWT({
      sid: claims.sessionId,
      typ: TYP_FOR[claims.accountType],
      // Informational for clients; the guard always loads roles from the database.
      ...(claims.accountType === 'STAFF' ? { roles: [...roles] } : {}),
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: this.keyId, typ: 'JWT' })
      .setSubject(claims.userId)
      .setIssuer(TOKEN_ISSUER)
      .setAudience(TOKEN_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
      .setJti(randomUUID())
      .sign(this.privateKey);
    return { token, expiresAt };
  }

  /** Returns the claims of a valid token, or `null` for any invalid, expired or foreign token. */
  async verify(token: string): Promise<AccessTokenClaims | null> {
    try {
      if (decodeProtectedHeader(token).kid !== this.keyId) return null;
      const { payload } = await jwtVerify(token, this.publicKey, {
        algorithms: ['EdDSA'],
        issuer: TOKEN_ISSUER,
        audience: TOKEN_AUDIENCE,
        requiredClaims: ['sub', 'sid', 'typ', 'exp', 'iat', 'jti'],
        clockTolerance: 5,
      });
      const accountType =
        payload['typ'] === 'customer' ? 'CUSTOMER' : payload['typ'] === 'staff' ? 'STAFF' : null;
      const sessionId = payload['sid'];
      if (accountType === null || typeof sessionId !== 'string' || !UUID.test(sessionId))
        return null;
      if (payload.sub === undefined || !UUID.test(payload.sub)) return null;
      return { userId: payload.sub, sessionId, accountType };
    } catch {
      return null;
    }
  }
}
