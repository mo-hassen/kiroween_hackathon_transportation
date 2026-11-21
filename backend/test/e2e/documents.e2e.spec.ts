import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import { ObjectStorage } from '../../src/infrastructure/storage/object-storage.js';
import { EICAR_SIGNATURE } from '../../src/providers/scanner/file-scanner.js';
import {
  bearer,
  type Customer,
  flushRateLimits,
  http,
  login,
  registerCustomer,
  seedStaff,
  staffLogin,
} from '../helpers/auth-helpers.js';
import {
  complete,
  createIntent,
  licenseJpeg,
  putObject,
  sha256,
  uploadDocument,
} from '../helpers/document-helpers.js';
import { minimalPdf } from '../helpers/document-fixtures.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

/** Private document storage against the real S3-compatible store (SeaweedFS). */
let testApp: TestApp;
let prisma: PrismaService;
let owner: Customer;

beforeAll(async () => {
  testApp = await createTestApp();
  prisma = testApp.app.get(PrismaService);
  await flushRateLimits();
  owner = await registerCustomer(testApp.app);
  await http(testApp.app).post('/api/v1/drivers/me').set(bearer(owner.tokens)).send({}).expect(201);
});
afterAll(async () => {
  await testApp.close();
});
beforeEach(flushRateLimits);

const app = () => testApp.app;
const row = (id: string) => prisma.document.findUniqueOrThrow({ where: { id } });
async function auditActions(id: string): Promise<string[]> {
  const rows = await prisma.auditLog.findMany({ where: { targetId: id }, orderBy: { seq: 'asc' } });
  return rows.map((r) => r.action);
}

describe('upload lifecycle', () => {
  it('intent -> direct PUT -> complete: AVAILABLE, re-encoded without EXIF, under a new key', async () => {
    const bytes = await licenseJpeg();
    const intent = await createIntent(app(), owner.tokens, bytes);
    expect(intent.body).toMatchObject({
      data: { document: { uploadStatus: 'PENDING_UPLOAD', reviewStatus: 'DRAFT' } },
    });
    const upload = (intent.body.data as { upload: { method: string; expiresAt: string } }).upload;
    expect(upload.method).toBe('PUT');
    const ttl = Date.parse(upload.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(4 * 60_000);
    expect(ttl).toBeLessThanOrEqual(5 * 60_000);
    const document = (intent.body.data as { document: Record<string, unknown> }).document;
    expect(Object.keys(document).sort()).toEqual(
      [
        'createdAt',
        'failureCode',
        'id',
        'mimeType',
        'processedAt',
        'purpose',
        'reviewStatus',
        'sizeBytes',
        'uploadStatus',
      ].sort(),
    );

    expect(await putObject(intent, bytes)).toBe(200);
    const done = await complete(app(), owner.tokens, intent.id);
    expect(done.data).toMatchObject({
      uploadStatus: 'AVAILABLE',
      mimeType: 'image/jpeg',
      failureCode: null,
    });

    const doc = await row(intent.id);
    expect(doc.storageKey).toMatch(/^documents\/\d{4}\/\d{2}\//);
    expect(doc.scanEngine).toBe('dev-eicar-only');
    const storage = app().get(ObjectStorage);
    expect(await storage.head(doc.uploadKey)).toBeNull();
    const stored = await storage.read(doc.storageKey ?? '', 10_000_000);
    expect(stored).not.toBeNull();
    expect((await sharp(stored ?? Buffer.alloc(0)).metadata()).exif).toBeUndefined();
    expect(doc.storedSha256).toBe(sha256(stored ?? Buffer.alloc(0)));
    expect(await auditActions(intent.id)).toEqual([
      'document.upload_initiated',
      'document.upload_completed',
    ]);
  });

  it('a re-upload to the incoming key after completion never reaches the stored copy', async () => {
    const bytes = await licenseJpeg();
    const intent = await createIntent(app(), owner.tokens, bytes);
    await putObject(intent, bytes);
    await complete(app(), owner.tokens, intent.id);
    const before = await row(intent.id);
    const evil = Buffer.concat([bytes.subarray(0, bytes.length - 10), Buffer.alloc(10, 1)]);
    await putObject(intent, evil);
    expect(await complete(app(), owner.tokens, intent.id)).toMatchObject({
      data: { uploadStatus: 'AVAILABLE' },
    });
    const after = await row(intent.id);
    expect(after.storedSha256).toBe(before.storedSha256);
    expect(after.version).toBe(before.version);
  });

  it('accepts a PDF without re-encoding it', async () => {
    const pdf = minimalPdf();
    const id = await uploadDocument(
      app(),
      owner.tokens,
      pdf,
      'DRIVER_LICENSE_BACK',
      'application/pdf',
    );
    expect(await row(id)).toMatchObject({
      uploadStatus: 'AVAILABLE',
      mimeType: 'application/pdf',
      storedSha256: sha256(pdf),
    });
  });

  it('completing before the upload reports UPLOAD_NOT_FOUND and stays retryable', async () => {
    const bytes = await licenseJpeg();
    const intent = await createIntent(app(), owner.tokens, bytes);
    expect((await complete(app(), owner.tokens, intent.id, 409)).code).toBe('UPLOAD_NOT_FOUND');
    expect((await row(intent.id)).uploadStatus).toBe('PENDING_UPLOAD');
    await putObject(intent, bytes);
    expect((await complete(app(), owner.tokens, intent.id)).data?.uploadStatus).toBe('AVAILABLE');
  });
});

describe('validation', () => {
  it('rejects a checksum mismatch', async () => {
    const bytes = await licenseJpeg();
    const intent = await createIntent(app(), owner.tokens, bytes, {
      sha: sha256(Buffer.from('other')),
    });
    await putObject(intent, bytes);
    expect((await complete(app(), owner.tokens, intent.id)).data).toMatchObject({
      uploadStatus: 'INVALID',
      failureCode: 'CHECKSUM_MISMATCH',
    });
    expect(await auditActions(intent.id)).toContain('document.validation_failed');
    expect(
      await app()
        .get(ObjectStorage)
        .head((await row(intent.id)).uploadKey),
    ).toBeNull();
  });

  it('rejects a file whose bytes are not the declared type (extension/magic-byte mismatch)', async () => {
    const html = Buffer.from('<html><body><script>alert(1)</script></body></html>');
    const intent = await createIntent(app(), owner.tokens, html, { mimeType: 'image/jpeg' });
    await putObject(intent, html);
    expect((await complete(app(), owner.tokens, intent.id)).data).toMatchObject({
      uploadStatus: 'INVALID',
      failureCode: 'UNSUPPORTED_TYPE',
    });

    const pdf = minimalPdf();
    const mismatch = await createIntent(app(), owner.tokens, pdf, { mimeType: 'image/png' });
    await putObject(mismatch, pdf);
    expect((await complete(app(), owner.tokens, mismatch.id)).data).toMatchObject({
      failureCode: 'TYPE_MISMATCH',
    });
  });

  it('rejects a malformed image and a PDF with active content', async () => {
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 3)]);
    const a = await createIntent(app(), owner.tokens, broken);
    await putObject(a, broken);
    expect((await complete(app(), owner.tokens, a.id)).data?.failureCode).toBe('MALFORMED_FILE');

    const pdf = minimalPdf(
      '3 0 obj << /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >> endobj',
    );
    const b = await createIntent(app(), owner.tokens, pdf, { mimeType: 'application/pdf' });
    await putObject(b, pdf);
    expect((await complete(app(), owner.tokens, b.id)).data?.failureCode).toBe('ACTIVE_CONTENT');
  });

  it('the storage refuses a body that differs from the signed size', async () => {
    const bytes = await licenseJpeg();
    const intent = await createIntent(app(), owner.tokens, bytes, {
      sizeBytes: bytes.length + 100,
    });
    expect(await putObject(intent, bytes)).not.toBe(200);
  });

  it('rejects unsupported types, oversized files and malformed hashes at the intent', async () => {
    const base = {
      purpose: 'DRIVER_LICENSE_FRONT',
      sizeBytes: 1000,
      sha256: sha256(Buffer.from('x')),
    };
    for (const [body, code] of [
      [{ ...base, mimeType: 'image/gif' }, 'IS_IN'],
      [{ ...base, mimeType: 'text/html' }, 'IS_IN'],
      [{ ...base, mimeType: 'image/jpeg', sizeBytes: 10_485_761 }, 'MAX'],
      [{ ...base, mimeType: 'image/jpeg', sha256: 'abc' }, 'MATCHES'],
      [{ ...base, mimeType: 'image/jpeg', purpose: 'VEHICLE_HOLOGRAM' }, 'IS_IN'],
      [{ ...base, mimeType: 'image/jpeg', storageKey: '../../etc/passwd' }, 'UNKNOWN_FIELD'],
    ] as const) {
      const res = await http(app())
        .post('/api/v1/documents')
        .set(bearer(owner.tokens))
        .send(body)
        .expect(400);
      expect(res.body.errors).toContainEqual(expect.objectContaining({ code }));
    }
  });

  it('a malware detection marks the document INFECTED and never available', async () => {
    const eicar = Buffer.concat([await licenseJpeg(), Buffer.from(EICAR_SIGNATURE, 'latin1')]);
    const intent = await createIntent(app(), owner.tokens, eicar);
    await putObject(intent, eicar);
    expect((await complete(app(), owner.tokens, intent.id)).data).toMatchObject({
      uploadStatus: 'INFECTED',
      failureCode: 'MALWARE_DETECTED',
    });
    expect(await auditActions(intent.id)).toContain('document.malware_detected');
    await http(app())
      .get(`/api/v1/documents/${intent.id}/url`)
      .set(bearer(owner.tokens))
      .expect(409);
  });

  it('requires a driver profile to upload licence images', async () => {
    const stranger = await registerCustomer(app());
    const res = await createIntent(app(), stranger.tokens, await licenseJpeg(), { expect: 409 });
    expect((res.body as { code: string }).code).toBe('DRIVER_PROFILE_REQUIRED');
  });
});

describe('scanner failure', () => {
  let disabled: TestApp;
  beforeAll(async () => {
    disabled = await createTestApp({ env: { FILE_SCANNER: 'disabled' } });
  });
  afterAll(async () => {
    await disabled.close();
  });

  it('a scanner outage never makes a document AVAILABLE; it stays retryable', async () => {
    const customer = await registerCustomer(disabled.app);
    await http(disabled.app)
      .post('/api/v1/drivers/me')
      .set(bearer(customer.tokens))
      .send({})
      .expect(201);
    const bytes = await licenseJpeg();
    const intent = await createIntent(disabled.app, customer.tokens, bytes);
    await putObject(intent, bytes);
    const res = await complete(disabled.app, customer.tokens, intent.id, 503);
    expect(res.code).toBe('DOCUMENT_SCAN_UNAVAILABLE');
    expect(await row(intent.id)).toMatchObject({ uploadStatus: 'UPLOADED', storageKey: null });
    expect(await auditActions(intent.id)).toContain('document.scan_unavailable');
    // The same file completes once a scanner is back (the default app, with its dev scanner;
    // each test app signs tokens with its own key, so sign in there).
    const tokens = await login(app(), customer.phone, customer.password, customer.device);
    expect((await complete(app(), tokens, intent.id)).data?.uploadStatus).toBe('AVAILABLE');
  });
});

describe('access control', () => {
  let ownId: string;
  let other: Customer;
  beforeAll(async () => {
    ownId = await uploadDocument(app(), owner.tokens, await licenseJpeg());
    other = await registerCustomer(app());
  });

  it('another user gets 404 for metadata, completion and download (IDOR)', async () => {
    await http(app()).get(`/api/v1/documents/${ownId}`).set(bearer(other.tokens)).expect(404);
    await http(app())
      .post(`/api/v1/documents/${ownId}/complete`)
      .set(bearer(other.tokens))
      .expect(404);
    await http(app()).get(`/api/v1/documents/${ownId}/url`).set(bearer(other.tokens)).expect(404);
    await http(app())
      .get(`/api/v1/documents/${randomUUID()}`)
      .set(bearer(owner.tokens))
      .expect(404);
  });

  it('requires authentication; staff have no customer document routes', async () => {
    await http(app()).get(`/api/v1/documents/${ownId}`).expect(401);
    await http(app()).post('/api/v1/documents').send({}).expect(401);
    const officer = await staffLogin(app(), await seedStaff(app(), ['VERIFICATION_OFFICER']));
    await http(app()).get(`/api/v1/documents/${ownId}/url`).set(bearer(officer)).expect(404);
    const res = await http(app())
      .post('/api/v1/documents')
      .set(bearer(officer))
      .send({
        purpose: 'DRIVER_LICENSE_FRONT',
        mimeType: 'image/jpeg',
        sizeBytes: 10,
        sha256: sha256(Buffer.from('x')),
      })
      .expect(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  it('the owner gets a 60-second URL with safe headers; it stops working when it expires', async () => {
    const res = await http(app())
      .get(`/api/v1/documents/${ownId}/url`)
      .set(bearer(owner.tokens))
      .expect(200);
    const { url, expiresAt, method } = res.body.data as {
      url: string;
      expiresAt: string;
      method: string;
    };
    expect(method).toBe('GET');
    expect(Date.parse(expiresAt) - Date.now()).toBeLessThanOrEqual(60_000);
    const download = await fetch(url);
    expect(download.status).toBe(200);
    expect(download.headers.get('cache-control')).toBe('private, no-store, max-age=0');
    expect(download.headers.get('content-type')).toBe('image/jpeg');
    expect(download.headers.get('content-disposition')).toMatch(
      /^inline; filename="driver_license_front.jpg"/,
    );
    expect(
      (await sharp(Buffer.from(await download.arrayBuffer())).metadata()).exif,
    ).toBeUndefined();

    const doc = await row(ownId);
    const short = await app()
      .get(ObjectStorage)
      .presignGet(doc.storageKey ?? '', {
        contentType: 'image/jpeg',
        disposition: 'inline',
        fileName: 'x.jpg',
        expiresInSeconds: 1,
      });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const expired = await fetch(short.url);
    await expired.arrayBuffer();
    expect(expired.status).toBe(403);
  });

  it('the bucket is private: unsigned and tampered requests are refused', async () => {
    const doc = await row(ownId);
    const endpoint = testApp.config.storage.endpoint ?? '';
    const bucket = testApp.config.storage.bucket;
    const anonymous = await fetch(`${endpoint}/${bucket}/${doc.storageKey ?? ''}`);
    await anonymous.arrayBuffer();
    expect(anonymous.status).toBe(403);
    const listing = await fetch(`${endpoint}/${bucket}?list-type=2`);
    await listing.arrayBuffer();
    expect(listing.status).toBe(403);

    const res = await http(app())
      .get(`/api/v1/documents/${ownId}/url`)
      .set(bearer(owner.tokens))
      .expect(200);
    const signed = new URL(res.body.data.url as string);
    const anotherKey = new URL(
      signed.toString().replace(doc.storageKey ?? '', `documents/2026/11/${randomUUID()}`),
    );
    const tampered = await fetch(anotherKey);
    await tampered.arrayBuffer();
    expect(tampered.status).toBe(403);
  });

  it('a document that is not AVAILABLE cannot be downloaded', async () => {
    const intent = await createIntent(app(), owner.tokens, await licenseJpeg());
    const res = await http(app())
      .get(`/api/v1/documents/${intent.id}/url`)
      .set(bearer(owner.tokens))
      .expect(409);
    expect(res.body.code).toBe('DOCUMENT_NOT_AVAILABLE');
  });
});
