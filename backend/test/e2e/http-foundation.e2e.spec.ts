import request from 'supertest';
import { ProbeModule } from '../helpers/probe.module.js';
import { createTestApp, type TestApp } from '../helpers/test-app.js';

const PROBLEM_JSON = /application\/problem\+json/;

describe('HTTP foundation', () => {
  let testApp: TestApp;
  const http = () => request(testApp.app.getHttpServer());

  beforeAll(async () => {
    testApp = await createTestApp({ extraModules: [ProbeModule] });
  });
  afterAll(async () => {
    await testApp.close();
  });

  describe('health', () => {
    it('GET /api/v1/health/live returns the success envelope', async () => {
      const res = await http().get('/api/v1/health/live').expect(200);
      expect(res.body).toEqual({ data: { status: 'ok' } });
    });

    it('GET /api/v1/health/ready reports every dependency up', async () => {
      const res = await http().get('/api/v1/health/ready').expect(200);
      expect(res.body).toEqual({
        data: { status: 'ok', checks: { database: 'up', redis: 'up', storage: 'up' } },
      });
    });

    it('is only served under the versioned prefix', async () => {
      await http().get('/health/live').expect(404);
      await http().get('/api/health/live').expect(404);
    });
  });

  describe('request id', () => {
    it('generates an X-Request-Id and includes it in error bodies', async () => {
      const res = await http().get('/api/v1/does-not-exist').expect(404);
      const id = res.headers['x-request-id'];
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      expect(res.body.requestId).toBe(id);
    });

    it('echoes a well-formed client request id', async () => {
      const res = await http()
        .get('/api/v1/health/live')
        .set('X-Request-Id', 'client-req-0001')
        .expect(200);
      expect(res.headers['x-request-id']).toBe('client-req-0001');
    });

    it('replaces a malformed client request id', async () => {
      const res = await http()
        .get('/api/v1/health/live')
        .set('X-Request-Id', 'bad id;drop')
        .expect(200);
      expect(res.headers['x-request-id']).not.toBe('bad id;drop');
    });
  });

  describe('error format (RFC 9457)', () => {
    it('returns problem details for unknown routes', async () => {
      const res = await http().get('/api/v1/nope').expect(404).expect('Content-Type', PROBLEM_JSON);
      expect(res.body).toMatchObject({
        type: 'urn:mobility:problem:not-found',
        status: 404,
        code: 'NOT_FOUND',
        title: expect.any(String),
      });
    });

    it('returns a stable domain error code', async () => {
      const res = await http()
        .get('/api/v1/probe/conflict')
        .expect(409)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('LISTING_NOT_AVAILABLE');
    });

    it('hides internal details of unexpected errors and logs them', async () => {
      const res = await http()
        .get('/api/v1/probe/crash')
        .expect(500)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('INTERNAL_ERROR');
      expect(JSON.stringify(res.body)).not.toMatch(/hunter2|postgres|stack|Error:/);
      expect(testApp.logs()).toContain(res.body.requestId);
    });
  });

  describe('validation', () => {
    it('accepts a valid body and returns it in the envelope', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'Abebe', rating: 5 })
        .expect(201);
      expect(res.body).toEqual({ data: { name: 'Abebe', rating: 5 } });
    });

    it('reports field errors with codes and never echoes values', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'x'.repeat(21), rating: 9 })
        .expect(400)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('VALIDATION_FAILED');
      expect(res.body.errors).toEqual(
        expect.arrayContaining([
          { field: 'name', code: 'MAX_LENGTH' },
          { field: 'rating', code: 'MAX' },
        ]),
      );
      expect(JSON.stringify(res.body)).not.toContain('xxxxxxxx');
    });

    it('rejects unknown fields (mass assignment)', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'Abebe', rating: 3, role: 'SUPER_ADMIN' })
        .expect(400);
      expect(res.body.errors).toContainEqual({ field: 'role', code: 'UNKNOWN_FIELD' });
    });

    it('does not coerce types implicitly', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .send({ name: 'Abebe', rating: '3' })
        .expect(400);
      expect(res.body.errors).toContainEqual({ field: 'rating', code: 'IS_INT' });
    });

    it('rejects malformed JSON with problem details', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .set('Content-Type', 'application/json')
        .send('{"name": ')
        .expect(400)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('MALFORMED_REQUEST');
    });

    it('rejects bodies over 1 MB', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ name: 'a'.repeat(1_100_000), rating: 1 }))
        .expect(413)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('PAYLOAD_TOO_LARGE');
    });

    it('ignores non-JSON bodies (no urlencoded parsing)', async () => {
      const res = await http()
        .post('/api/v1/probe/echo')
        .type('form')
        .send('name=Abebe&rating=3')
        .expect(400);
      expect(res.body.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('authentication guard', () => {
    it('rejects routes not marked @Public() (fail closed)', async () => {
      const res = await http()
        .get('/api/v1/probe/protected')
        .expect(401)
        .expect('Content-Type', PROBLEM_JSON);
      expect(res.body.code).toBe('UNAUTHENTICATED');
      expect(JSON.stringify(res.body)).not.toContain('should never be returned');
    });

    it('rejects them even when a bearer token is presented (no token issuance yet)', async () => {
      await http()
        .get('/api/v1/probe/protected')
        .set('Authorization', 'Bearer forged.jwt.token')
        .expect(401);
    });
  });

  describe('security headers', () => {
    it('sets helmet headers and hides the framework', async () => {
      const res = await http().get('/api/v1/health/live').expect(200);
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['x-frame-options']).toBe('SAMEORIGIN');
      expect(res.headers['content-security-policy']).toContain("default-src 'self'");
      expect(res.headers['referrer-policy']).toBe('no-referrer');
      expect(res.headers['cross-origin-resource-policy']).toBe('same-site');
      expect(res.headers['x-powered-by']).toBeUndefined();
    });

    it('does not send HSTS outside deployed environments', async () => {
      const res = await http().get('/api/v1/health/live');
      expect(res.headers['strict-transport-security']).toBeUndefined();
    });
  });

  describe('CORS', () => {
    it('allows a configured origin', async () => {
      const res = await http()
        .options('/api/v1/probe/echo')
        .set('Origin', 'http://localhost:8080')
        .set('Access-Control-Request-Method', 'POST')
        .set('Access-Control-Request-Headers', 'content-type,idempotency-key');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('http://localhost:8080');
      expect(res.headers['access-control-allow-credentials']).toBeUndefined();
    });

    it('does not allow other origins', async () => {
      const res = await http()
        .options('/api/v1/probe/echo')
        .set('Origin', 'https://evil.example')
        .set('Access-Control-Request-Method', 'POST');
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
      const get = await http().get('/api/v1/health/live').set('Origin', 'https://evil.example');
      expect(get.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('serves requests without an Origin header (mobile clients)', async () => {
      const res = await http().get('/api/v1/health/live').expect(200);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
  });
});
