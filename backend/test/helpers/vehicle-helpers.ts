import { randomBytes, randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import { bearer, type Customer, http, type Tokens } from './auth-helpers.js';
import { uploadDocument } from './document-helpers.js';
import {
  claimOwner,
  decide,
  INDIVIDUAL_APPROVAL,
  preparedOwner,
  type Owner,
} from './owner-helpers.js';

export const SLOTS = [
  'REGISTRATION',
  'OWNERSHIP',
  'INSURANCE',
  'INSPECTION',
  'PHOTO_FRONT',
  'PHOTO_BACK',
  'PHOTO_LEFT',
  'PHOTO_RIGHT',
  'PHOTO_PLATE',
] as const;
export type Slot = (typeof SLOTS)[number] | 'PHOTO_INTERIOR';

const PURPOSE: Record<string, string> = {
  REGISTRATION: 'VEHICLE_REGISTRATION',
  OWNERSHIP: 'VEHICLE_OWNERSHIP',
  INSURANCE: 'VEHICLE_INSURANCE',
  INSPECTION: 'VEHICLE_INSPECTION',
};
export const purposeOf = (slot: Slot): string => PURPOSE[slot] ?? 'VEHICLE_PHOTO';
const EXPIRING = new Set<Slot>(['INSURANCE', 'INSPECTION']);

/** `YYYY-MM-DD`, [days] from now (Addis Ababa is UTC+3). */
export function dateIn(days: number): string {
  return new Date(Date.now() + 3 * 3_600_000 + days * 86_400_000).toISOString().slice(0, 10);
}

/** A unique plate (the plate is a unique key across the whole table). */
export function uniquePlate(): { plateRegion: string; plateCode: string; plateNumber: string } {
  return {
    plateRegion: 'AA',
    plateCode: '2',
    plateNumber: randomBytes(4).toString('hex').toUpperCase(),
  };
}
export function uniqueVin(): string {
  return `T${randomBytes(8).toString('hex').toUpperCase()}`;
}

export function vehicleBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    vehicleType: 'SEDAN',
    make: 'Toyota',
    model: 'Vitz',
    year: 2018,
    color: 'White',
    seats: 5,
    transmission: 'AUTOMATIC',
    fuelType: 'PETROL',
    ...uniquePlate(),
    vin: uniqueVin(),
    engineNumber: `E${randomBytes(4).toString('hex').toUpperCase()}`,
    ...overrides,
  };
}

/** A distinct image per label and call (every evidence file must differ in bytes). */
export async function vehicleImage(label: string): Promise<Buffer> {
  const seed = randomBytes(3);
  return sharp({
    create: {
      width: 320,
      height: 240,
      channels: 3,
      background: { r: seed[0] ?? 0, g: seed[1] ?? 0, b: seed[2] ?? 0 },
    },
  })
    .jpeg({ quality: 85 })
    .withMetadata({ exif: { IFD0: { ImageDescription: label } } })
    .toBuffer();
}

/* eslint-disable @typescript-eslint/no-explicit-any -- loose JSON body in tests */
export const bodyOf = (res: { body: { data?: unknown } }): Record<string, any> =>
  res.body.data as Record<string, any>;
/* eslint-enable @typescript-eslint/no-explicit-any */

export async function createVehicle(
  app: NestExpressApplication,
  tokens: Tokens,
  overrides: Record<string, unknown> = {},
  expect = 201,
) {
  return http(app)
    .post('/api/v1/vehicles')
    .set(bearer(tokens))
    .send(vehicleBody(overrides))
    .expect(expect);
}

export async function uploadEvidence(
  app: NestExpressApplication,
  tokens: Tokens,
  slot: Slot,
): Promise<string> {
  return uploadDocument(
    app,
    tokens,
    await vehicleImage(slot),
    purposeOf(slot) as Parameters<typeof uploadDocument>[3],
  );
}

export async function attachEvidence(
  app: NestExpressApplication,
  tokens: Tokens,
  vehicleId: string,
  slot: Slot,
  documentId: string,
  expect = 200,
  expiresOn?: string,
) {
  const body: Record<string, unknown> = { documentId };
  const date = expiresOn ?? (EXPIRING.has(slot) ? dateIn(200) : undefined);
  if (date !== undefined) body.expiresOn = date;
  return http(app)
    .put(`/api/v1/vehicles/${vehicleId}/evidence/${slot}`)
    .set(bearer(tokens))
    .send(body)
    .expect(expect);
}

export async function submitVehicle(
  app: NestExpressApplication,
  tokens: Tokens,
  vehicleId: string,
  expect = 200,
  key: string = randomUUID(),
) {
  return http(app)
    .post(`/api/v1/vehicles/${vehicleId}/submit`)
    .set(bearer(tokens))
    .set('Idempotency-Key', key)
    .expect(expect);
}

export interface PreparedVehicle {
  id: string;
  documents: Partial<Record<Slot, string>>;
}

/** A vehicle with all required evidence; optionally submitted. */
export async function preparedVehicle(
  app: NestExpressApplication,
  tokens: Tokens,
  options: { submit?: boolean; overrides?: Record<string, unknown>; skip?: Slot[] } = {},
): Promise<PreparedVehicle> {
  const created = await createVehicle(app, tokens, options.overrides);
  const id = bodyOf(created).id as string;
  const documents: Partial<Record<Slot, string>> = {};
  const slots = SLOTS.filter((slot) => !options.skip?.includes(slot));
  const ids = await Promise.all(slots.map((slot) => uploadEvidence(app, tokens, slot)));
  for (const [index, slot] of slots.entries()) {
    documents[slot] = ids[index];
    await attachEvidence(app, tokens, id, slot, ids[index] as string);
  }
  if (options.submit ?? false) await submitVehicle(app, tokens, id);
  return { id, documents };
}

/** An individual owner approved by [officer]: may register vehicles. */
export async function verifiedOwner(
  app: NestExpressApplication,
  officer: Tokens,
  customer?: Customer,
): Promise<Owner> {
  const owner = await preparedOwner(app, {
    type: 'INDIVIDUAL',
    submit: true,
    ...(customer === undefined ? {} : { customer }),
  });
  await claimOwner(app, officer, owner.profileId);
  await decide(app, officer, owner.profileId, 'approve', INDIVIDUAL_APPROVAL);
  return owner;
}

export const adminVehicle = (path: string): string => `/api/v1/admin/vehicle-verifications${path}`;
export const VEHICLE_APPROVAL = {
  detailsMatch: true,
  ownerMatchesRegistration: true,
  documentsLegible: true,
  photosMatch: true,
};
export const VEHICLE_VIEW_REASON = { reason: 'Checking the vehicle registration photo' };

export async function decideVehicle(
  app: NestExpressApplication,
  tokens: Tokens,
  vehicleId: string,
  action: string,
  body: object = {},
  expect = 200,
  key: string = randomUUID(),
) {
  return http(app)
    .post(adminVehicle(`/${vehicleId}/${action}`))
    .set(bearer(tokens))
    .set('Idempotency-Key', key)
    .send(body)
    .expect(expect);
}

export async function claimVehicle(
  app: NestExpressApplication,
  tokens: Tokens,
  vehicleId: string,
  expect = 200,
) {
  return http(app)
    .post(adminVehicle(`/${vehicleId}/claim`))
    .set(bearer(tokens))
    .expect(expect);
}

/** Claim and approve in one go. */
export async function approveVehicle(
  app: NestExpressApplication,
  officer: Tokens,
  vehicleId: string,
): Promise<void> {
  await claimVehicle(app, officer, vehicleId);
  await decideVehicle(app, officer, vehicleId, 'approve', VEHICLE_APPROVAL);
}
