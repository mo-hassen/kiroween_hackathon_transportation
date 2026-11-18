import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  CompactEncrypt,
  exportJWK,
  generateKeyPair,
  importJWK,
  type JWK,
  jwtVerify,
  SignJWT,
} from 'jose';

/**
 * A simulated OIDC provider for tests (NOT eSignet). It implements what the relying-party
 * side needs: discovery, JWKS, authorization code + PKCE S256, a token endpoint that
 * verifies the private_key_jwt client assertion, RS256 ID tokens and signed (optionally
 * encrypted) user information. Modes make it misbehave in specific ways.
 */
export const FAKE_MODES = [
  'ok',
  'wrong_issuer',
  'wrong_audience',
  'expired_id_token',
  'foreign_key',
  'missing_nonce',
  'low_acr',
  'userinfo_sub_mismatch',
  'unsigned_userinfo',
  'encrypted_userinfo',
  'bad_birthdate',
  'token_server_error',
  'invalid_grant',
  'hang',
] as const;
export type FakeMode = (typeof FAKE_MODES)[number];

type CryptoKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

export const FAKE_ACR = 'mosip:idp:acr:biometrics';

interface IssuedCode {
  readonly redirectUri: string;
  readonly challenge: string;
  readonly nonce: string;
  readonly subject: string;
  readonly name: string;
  readonly birthdate: string;
  readonly mode: FakeMode;
}

export interface FakeOidcOptions {
  readonly clientId: string;
  readonly clientPublicJwk: JWK;
  readonly userinfoPublicJwk?: JWK;
}

export interface AuthorizeOverrides {
  readonly mode?: FakeMode;
  readonly subject?: string;
  readonly name?: string;
  readonly birthdate?: string;
}

export async function generateRsaJwkPair(
  kid: string,
  alg: 'RS256' | 'RSA-OAEP-256' = 'RS256',
): Promise<{ privateJwk: JWK; publicJwk: JWK }> {
  const { privateKey, publicKey } = await generateKeyPair(alg, {
    modulusLength: 2048,
    extractable: true,
  });
  return {
    privateJwk: { ...(await exportJWK(privateKey)), kid, alg },
    publicJwk: { ...(await exportJWK(publicKey)), kid, alg },
  };
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

export class FakeOidcProvider {
  issuer = '';
  readonly tokenRequests: URLSearchParams[] = [];
  lastAuthorization: URLSearchParams | undefined;
  private readonly codes = new Map<string, IssuedCode>();
  private readonly accessTokens = new Map<string, IssuedCode>();
  private readonly seenJtis = new Set<string>();
  private readonly hanging = new Set<ServerResponse>();
  private server: Server | undefined;
  private signingKey: CryptoKey | undefined;
  private foreignKey: CryptoKey | undefined;
  private publicJwk: JWK | undefined;

  private constructor(private readonly options: FakeOidcOptions) {}

  static async start(options: FakeOidcOptions): Promise<FakeOidcProvider> {
    const provider = new FakeOidcProvider(options);
    const signing = await generateKeyPair('RS256', { modulusLength: 2048, extractable: true });
    const foreign = await generateKeyPair('RS256', { modulusLength: 2048 });
    provider.signingKey = signing.privateKey;
    provider.foreignKey = foreign.privateKey;
    provider.publicJwk = {
      ...(await exportJWK(signing.publicKey)),
      kid: 'fake-key-1',
      alg: 'RS256',
      use: 'sig',
    };
    provider.server = createServer((request, response) => {
      provider.handle(request, response).catch(() => {
        if (!response.headersSent) json(response, 500, { error: 'unknown_error' });
      });
    });
    await new Promise<void>((resolve) => provider.server?.listen(0, '127.0.0.1', resolve));
    const { port } = provider.server.address() as AddressInfo;
    provider.issuer = `http://127.0.0.1:${port}`;
    return provider;
  }

  async close(): Promise<void> {
    for (const response of this.hanging) response.destroy();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  get tokenEndpoint(): string {
    return `${this.issuer}/token`;
  }

  /** What the browser would get after authenticating at the provider. */
  authorize(
    authorizationUrl: string,
    overrides: AuthorizeOverrides = {},
  ): { code: string; state: string; redirectUri: string } {
    const params = new URL(authorizationUrl).searchParams;
    this.lastAuthorization = params;
    if (
      params.get('client_id') !== this.options.clientId ||
      params.get('response_type') !== 'code' ||
      params.get('code_challenge_method') !== 'S256'
    ) {
      throw new Error('invalid authorization request');
    }
    const code = randomBytes(24).toString('base64url');
    this.codes.set(code, {
      redirectUri: params.get('redirect_uri') ?? '',
      challenge: params.get('code_challenge') ?? '',
      nonce: params.get('nonce') ?? '',
      subject: overrides.subject ?? `psut-${randomBytes(8).toString('hex')}`,
      name: overrides.name ?? 'Almaz Ayana Eba',
      birthdate: overrides.birthdate ?? '1991/11/21',
      mode: overrides.mode ?? 'ok',
    });
    return {
      code,
      state: params.get('state') ?? '',
      redirectUri: params.get('redirect_uri') ?? '',
    };
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', this.issuer);
    if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      json(response, 200, {
        issuer: this.issuer,
        authorization_endpoint: `${this.issuer}/authorize`,
        token_endpoint: this.tokenEndpoint,
        userinfo_endpoint: `${this.issuer}/userinfo`,
        jwks_uri: `${this.issuer}/jwks`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['RS256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
      });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/jwks') {
      json(response, 200, { keys: [this.publicJwk] });
      return;
    }
    if (request.method === 'GET' && url.pathname === '/authorize') {
      // Browser flow for e2e tests: test_* parameters stand in for the user's choices.
      const mode = (url.searchParams.get('test_mode') ?? 'ok') as FakeMode;
      const subject = url.searchParams.get('test_subject') ?? undefined;
      const { code, state, redirectUri } = this.authorize(url.toString(), {
        mode,
        ...(subject === undefined ? {} : { subject }),
      });
      const target = new URL(redirectUri);
      target.search = new URLSearchParams({ code, state }).toString();
      response.writeHead(302, { Location: target.toString() });
      response.end();
      return;
    }
    if (request.method === 'POST' && url.pathname === '/token') {
      await this.token(new URLSearchParams(await readBody(request)), response);
      return;
    }
    if (request.method === 'GET' && url.pathname === '/userinfo') {
      await this.userinfo(request, response);
      return;
    }
    json(response, 404, { error: 'not_found' });
  }

  private async token(form: URLSearchParams, response: ServerResponse): Promise<void> {
    this.tokenRequests.push(form);
    // private_key_jwt (RFC 7523): iss = sub = client_id, aud = token endpoint, fresh jti.
    try {
      const key = await importJWK(this.options.clientPublicJwk, 'RS256');
      const { payload } = await jwtVerify(form.get('client_assertion') ?? '', key, {
        issuer: this.options.clientId,
        subject: this.options.clientId,
        audience: this.tokenEndpoint,
        algorithms: ['RS256'],
        requiredClaims: ['jti', 'iat', 'exp'],
      });
      if (
        form.get('client_assertion_type') !==
          'urn:ietf:params:oauth:client-assertion-type:jwt-bearer' ||
        form.get('client_id') !== this.options.clientId ||
        typeof payload.jti !== 'string' ||
        this.seenJtis.has(payload.jti) ||
        (payload.exp ?? 0) - (payload.iat ?? 0) > 300
      ) {
        throw new Error('bad assertion');
      }
      this.seenJtis.add(payload.jti);
    } catch {
      json(response, 400, { error: 'invalid_client', error_description: 'invalid_client' });
      return;
    }
    const code = form.get('code') ?? '';
    const issued = this.codes.get(code);
    this.codes.delete(code);
    const verifier = form.get('code_verifier') ?? '';
    const challenge = createHash('sha256').update(verifier, 'ascii').digest('base64url');
    if (
      form.get('grant_type') !== 'authorization_code' ||
      issued === undefined ||
      issued.redirectUri !== form.get('redirect_uri') ||
      issued.challenge !== challenge ||
      issued.mode === 'invalid_grant'
    ) {
      json(response, 400, { error: 'invalid_grant' });
      return;
    }
    if (issued.mode === 'token_server_error') {
      json(response, 500, { error: 'unknown_error' });
      return;
    }
    if (issued.mode === 'hang') {
      this.hanging.add(response);
      response.on('close', () => this.hanging.delete(response));
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      acr: issued.mode === 'low_acr' ? 'mosip:idp:acr:static-code' : FAKE_ACR,
      auth_time: now,
      ...(issued.mode === 'missing_nonce' ? {} : { nonce: issued.nonce }),
    };
    const idToken = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key-1', typ: 'JWT' })
      .setIssuer(issued.mode === 'wrong_issuer' ? 'https://attacker.example' : this.issuer)
      .setAudience(issued.mode === 'wrong_audience' ? 'another-client' : this.options.clientId)
      .setSubject(issued.subject)
      .setIssuedAt(issued.mode === 'expired_id_token' ? now - 7200 : now)
      .setExpirationTime(issued.mode === 'expired_id_token' ? now - 3600 : now + 3600)
      .sign((issued.mode === 'foreign_key' ? this.foreignKey : this.signingKey) as CryptoKey);
    const accessToken = randomBytes(24).toString('base64url');
    this.accessTokens.set(accessToken, issued);
    json(response, 200, {
      access_token: accessToken,
      id_token: idToken,
      token_type: 'Bearer',
      expires_in: 3600,
    });
  }

  private async userinfo(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1] ?? '';
    const issued = this.accessTokens.get(token);
    if (issued === undefined) {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer error="invalid_token"' });
      response.end();
      return;
    }
    const claims = {
      sub: issued.mode === 'userinfo_sub_mismatch' ? 'someone-else' : issued.subject,
      name: issued.name,
      birthdate: issued.mode === 'bad_birthdate' ? 'last tuesday' : issued.birthdate,
    };
    if (issued.mode === 'unsigned_userinfo') {
      json(response, 200, claims);
      return;
    }
    let body = await new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'fake-key-1' })
      .setIssuer(this.issuer)
      .setAudience(this.options.clientId)
      .setIssuedAt()
      .sign(this.signingKey as CryptoKey);
    if (issued.mode === 'encrypted_userinfo') {
      const key = await importJWK(this.options.userinfoPublicJwk ?? {}, 'RSA-OAEP-256');
      body = await new CompactEncrypt(new TextEncoder().encode(body))
        .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM', cty: 'JWT' })
        .encrypt(key);
    }
    response.writeHead(200, { 'Content-Type': 'application/jwt' });
    response.end(body);
  }
}
