import { createHash, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { bearer, type Customer, http, registerCustomer, type Tokens } from './auth-helpers.js';
import { verifyIdentity } from './identity-helpers.js';

export type Purpose = 'DRIVER_LICENSE_FRONT' | 'DRIVER_LICENSE_BACK';

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** A licence-like JPEG with GPS EXIF (the server must remove it). */
export async function licenseJpeg(label = 'front'): Promise<Buffer> {
  return sharp({
    create: {
      width: 320,
      height: 200,
      channels: 3,
      background: label === 'front' ? '#2a6' : '#a62',
    },
  })
    .jpeg({ quality: 90 })
    .withExif({
      IFD0: { Make: 'PhoneCam', Model: `Model-${label}` },
      IFD3: {
        GPSLatitudeRef: 'N',
        GPSLatitude: '9/1 1/1 30/1',
        GPSLongitudeRef: 'E',
        GPSLongitude: '38/1 45/1 0/1',
      },
    })
    .toBuffer();
}

export interface Intent {
  readonly id: string;
  readonly url: string;
  readonly headers: Record<string, string>;
}

export async function createIntent(
  app: NestExpressApplication,
  tokens: Tokens,
  bytes: Buffer,
  options: {
    purpose?: Purpose;
    mimeType?: string;
    sizeBytes?: number;
    sha?: string;
    expect?: number;
  } = {},
): Promise<Intent & { status: number; body: Record<string, unknown> }> {
  const res = await http(app)
    .post('/api/v1/documents')
    .set(bearer(tokens))
    .send({
      purpose: options.purpose ?? 'DRIVER_LICENSE_FRONT',
      mimeType: options.mimeType ?? 'image/jpeg',
      sizeBytes: options.sizeBytes ?? bytes.length,
      sha256: options.sha ?? sha256(bytes),
    })
    .expect(options.expect ?? 201);
  const data = (res.body.data ?? {}) as { document?: { id: string }; upload?: Intent };
  return {
    id: data.document?.id ?? '',
    url: data.upload?.url ?? '',
    headers: data.upload?.headers ?? {},
    status: res.status,
    body: res.body as Record<string, unknown>,
  };
}

/** The client's direct PUT to object storage. */
export async function putObject(
  intent: Intent,
  bytes: Buffer,
  contentType?: string,
): Promise<number> {
  const res = await fetch(intent.url, {
    method: 'PUT',
    headers: {
      ...intent.headers,
      ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
    },
    body: new Uint8Array(bytes),
  });
  await res.arrayBuffer();
  return res.status;
}

export async function complete(
  app: NestExpressApplication,
  tokens: Tokens,
  id: string,
  expect = 200,
) {
  const res = await http(app)
    .post(`/api/v1/documents/${id}/complete`)
    .set(bearer(tokens))
    .expect(expect);
  return res.body as {
    data?: { uploadStatus: string; failureCode: string | null; mimeType: string };
    code?: string;
  };
}

/** Intent, PUT, complete: returns the document id (AVAILABLE unless the file is bad). */
export async function uploadDocument(
  app: NestExpressApplication,
  tokens: Tokens,
  bytes: Buffer,
  purpose: Purpose = 'DRIVER_LICENSE_FRONT',
  mimeType = 'image/jpeg',
): Promise<string> {
  const intent = await createIntent(app, tokens, bytes, { purpose, mimeType });
  expect(await putObject(intent, bytes)).toBe(200);
  await complete(app, tokens, intent.id);
  return intent.id;
}

export const LICENSE_DETAILS = {
  categories: ['B'],
  issuedOn: '2022-03-01',
  expiresOn: '2030-03-01',
  issuingAuthority: 'Addis Ababa Driver and Vehicle Licensing Authority',
};

export function uniqueLicenseNumber(): string {
  return `AA${randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
}

export interface Driver extends Customer {
  licenseId: string;
  licenseNumber: string;
  frontId: string;
  backId: string;
}

/**
 * A customer with verified identity, a driver profile, licence details and both licence
 * documents attached; optionally submitted.
 */
export async function preparedDriver(
  app: NestExpressApplication,
  options: { submit?: boolean; verified?: boolean } = {},
): Promise<Driver> {
  const customer = await registerCustomer(app);
  if (options.verified ?? true) await verifyIdentity(app, customer.tokens);
  await http(app)
    .post('/api/v1/drivers/me')
    .set(bearer(customer.tokens))
    .send({ yearsLicensed: 4, homeSubCity: 'BOLE' })
    .expect(201);
  const licenseNumber = uniqueLicenseNumber();
  const license = await http(app)
    .post('/api/v1/drivers/me/licenses')
    .set(bearer(customer.tokens))
    .send({ ...LICENSE_DETAILS, licenseNumber })
    .expect(201);
  const licenseId = license.body.data.id as string;
  const frontId = await uploadDocument(
    app,
    customer.tokens,
    await licenseJpeg('front'),
    'DRIVER_LICENSE_FRONT',
  );
  const backId = await uploadDocument(
    app,
    customer.tokens,
    await licenseJpeg('back'),
    'DRIVER_LICENSE_BACK',
  );
  await attach(app, customer.tokens, licenseId, 'front', frontId);
  await attach(app, customer.tokens, licenseId, 'back', backId);
  if (options.submit ?? false) await submit(app, customer.tokens, licenseId);
  return { ...customer, licenseId, licenseNumber, frontId, backId };
}

export async function attach(
  app: NestExpressApplication,
  tokens: Tokens,
  licenseId: string,
  side: 'front' | 'back',
  documentId: string,
  expect = 200,
) {
  return http(app)
    .put(`/api/v1/drivers/me/licenses/${licenseId}/documents/${side}`)
    .set(bearer(tokens))
    .send({ documentId })
    .expect(expect);
}

export async function submit(
  app: NestExpressApplication,
  tokens: Tokens,
  licenseId: string,
  expect = 200,
  key = randomUUID(),
) {
  return http(app)
    .post(`/api/v1/drivers/me/licenses/${licenseId}/submit`)
    .set(bearer(tokens))
    .set('Idempotency-Key', key)
    .expect(expect);
}

export const APPROVE = { identityMatches: true, documentsLegible: true, detailsMatch: true };
export const VIEW_REASON = { reason: 'Reviewing the licence images for this case' };
