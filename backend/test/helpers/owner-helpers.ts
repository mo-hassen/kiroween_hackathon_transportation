import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { bearer, type Customer, http, registerCustomer, type Tokens } from './auth-helpers.js';
import { uploadDocument } from './document-helpers.js';
import { verifyIdentity } from './identity-helpers.js';

export type OwnerSlot = 'tin' | 'business-license' | 'representative-letter';
export const SLOTS: Record<
  OwnerSlot,
  'OWNER_TIN' | 'OWNER_BUSINESS_LICENSE' | 'OWNER_REPRESENTATIVE_LETTER'
> = {
  tin: 'OWNER_TIN',
  'business-license': 'OWNER_BUSINESS_LICENSE',
  'representative-letter': 'OWNER_REPRESENTATIVE_LETTER',
};

/** A random 10-digit TIN-like value (no official format is assumed). */
export function uniqueTin(): string {
  return String(randomBytes(5).readUIntBE(0, 5) % 10_000_000_000).padStart(10, '0');
}

/** A document photo with GPS EXIF (the server must remove it). */
export async function ownerDocJpeg(label: string): Promise<Buffer> {
  // A distinct colour per label, so the three documents never have the same bytes.
  let sum = 0;
  for (let i = 0; i < label.length; i++) sum = (sum + label.charCodeAt(i)) % 200;
  const shade = sum + 30;
  return sharp({
    create: { width: 300, height: 400, channels: 3, background: { r: shade, g: 120, b: 80 } },
  })
    .jpeg({ quality: 90 })
    .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '9/1 1/1 30/1' } })
    .toBuffer();
}

export const ORG_APPROVAL = {
  identityConfirmed: true,
  documentsLegible: true,
  organizationDetailsMatch: true,
  representativeAuthorized: true,
};
export const INDIVIDUAL_APPROVAL = { identityConfirmed: true };
export const OWNER_VIEW_REASON = { reason: 'Checking the organization documents' };

export interface Owner extends Customer {
  profileId: string;
  ownerType: 'INDIVIDUAL' | 'ORGANIZATION';
  tin: string | null;
  documents: Partial<Record<OwnerSlot, string>>;
}

export async function attachOwnerDocument(
  app: NestExpressApplication,
  tokens: Tokens,
  slot: OwnerSlot,
  documentId: string,
  expect = 200,
) {
  return http(app)
    .put(`/api/v1/owners/me/documents/${slot}`)
    .set(bearer(tokens))
    .send({ documentId })
    .expect(expect);
}

export async function uploadOwnerDocument(
  app: NestExpressApplication,
  tokens: Tokens,
  slot: OwnerSlot,
): Promise<string> {
  return uploadDocument(app, tokens, await ownerDocJpeg(slot), SLOTS[slot]);
}

/** Uploads and attaches all three organization documents; returns their ids. */
export async function attachAllOwnerDocuments(
  app: NestExpressApplication,
  tokens: Tokens,
): Promise<Record<OwnerSlot, string>> {
  const result = {} as Record<OwnerSlot, string>;
  for (const slot of Object.keys(SLOTS) as OwnerSlot[]) {
    result[slot] = await uploadOwnerDocument(app, tokens, slot);
    await attachOwnerDocument(app, tokens, slot, result[slot]);
  }
  return result;
}

export async function submitOwner(
  app: NestExpressApplication,
  tokens: Tokens,
  expect = 200,
  key = randomUUID(),
) {
  return http(app)
    .post('/api/v1/owners/me/submit')
    .set(bearer(tokens))
    .set('Idempotency-Key', key)
    .expect(expect);
}

/**
 * A customer with a verified identity (unless `verified: false`), an owner profile of the
 * given type and, for organizations, all three documents attached; optionally submitted.
 */
export async function preparedOwner(
  app: NestExpressApplication,
  options: {
    type?: 'INDIVIDUAL' | 'ORGANIZATION';
    submit?: boolean;
    verified?: boolean;
    customer?: Customer;
  } = {},
): Promise<Owner> {
  const type = options.type ?? 'ORGANIZATION';
  const customer = options.customer ?? (await registerCustomer(app));
  if (options.verified ?? true) await verifyIdentity(app, customer.tokens);
  const tin = type === 'ORGANIZATION' ? uniqueTin() : null;
  const created = await http(app)
    .post('/api/v1/owners/me')
    .set(bearer(customer.tokens))
    .send(
      type === 'ORGANIZATION'
        ? { ownerType: type, organizationName: 'Abebe Transport PLC', tin }
        : { ownerType: type },
    )
    .expect(201);
  const documents =
    type === 'ORGANIZATION' ? await attachAllOwnerDocuments(app, customer.tokens) : {};
  if (options.submit ?? false) await submitOwner(app, customer.tokens);
  return {
    ...customer,
    profileId: created.body.data.id as string,
    ownerType: type,
    tin,
    documents,
  };
}

export const adminOwner = (path: string): string => `/api/v1/admin/owner-verifications${path}`;

/** POST an officer decision with an Idempotency-Key. */
export async function decide(
  app: NestExpressApplication,
  tokens: Tokens,
  ownerId: string,
  action: string,
  body: object = {},
  expect = 200,
  key = randomUUID(),
) {
  return http(app)
    .post(adminOwner(`/${ownerId}/${action}`))
    .set(bearer(tokens))
    .set('Idempotency-Key', key)
    .send(body)
    .expect(expect);
}

export async function claimOwner(
  app: NestExpressApplication,
  tokens: Tokens,
  ownerId: string,
  expect = 200,
) {
  return http(app)
    .post(adminOwner(`/${ownerId}/claim`))
    .set(bearer(tokens))
    .expect(expect);
}

export const TIN_CHECK_REASON = 'Comparing the TIN with the certificate';

/** The officer types the TIN read on the certificate; returns the HTTP response. */
export async function checkTin(
  app: NestExpressApplication,
  tokens: Tokens,
  ownerId: string,
  tin: string,
  expect = 200,
  reason = TIN_CHECK_REASON,
) {
  return http(app)
    .post(adminOwner(`/${ownerId}/tin-check`))
    .set(bearer(tokens))
    .send({ tin, reason })
    .expect(expect);
}
