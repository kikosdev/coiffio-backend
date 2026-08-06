/**
 * Prompt 7 (Entitlements), rendu permanent (Prompt 9). Conversion directe de la preuve
 * scratch validée par l'utilisateur (15/15) : fallback starter sans CP, JWT RS256
 * valide/expiré/falsifié/mismatch via un faux CP local, guards HARD (403) et SOFT (notif).
 */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import * as http from 'http';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  fetchJson,
  signStaffJwt,
  authHeader,
  jsonHeaders,
  CP_SHARED_SECRET,
  TestDb,
  TestApp,
} from './utils/test-app';
import { EntitlementsService } from '../src/common/entitlements/entitlements.service';

describe('entitlements (Prompt 7) — no CP configured (Sprint 1 fallback)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerTokenValue: string;

  beforeAll(async () => {
    testDb = await startTestDb('entitlements_fallback');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'ent-fallback-salon' });
    tenantId = salon.tenantId;
    locationId = salon.locations[0].id;
    const owner = await seedStaff(testDb.db, { tenantId, role: 'owner', locationIds: [locationId], defaultLocationId: locationId });
    ownerTokenValue = signStaffJwt({ sub: owner.userId, salonId: tenantId, role: 'owner', staffId: owner.staffId });
    // staffMax par défaut = 10 : sature à 10 (1 owner + 9 fillers) pour prouver le HARD limit.
    for (let i = 0; i < 9; i++) {
      await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [locationId], defaultLocationId: locationId, name: `Filler ${i}` });
    }
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function ownerToken(): Promise<string> {
    return ownerTokenValue;
  }

  it('starter fallback grants pos/ecommerce/analytics (no regression on existing prod functionality)', async () => {
    const token = await ownerToken();
    const [pos, orders, reports] = await Promise.all([
      fetchJson(`${testApp.baseUrl}/pos/roster`, { headers: authHeader(token) }),
      fetchJson(`${testApp.baseUrl}/orders`, { headers: authHeader(token) }),
      fetchJson(`${testApp.baseUrl}/reports`, { headers: authHeader(token) }),
    ]);
    expect(pos.status).toBe(200);
    expect(orders.status).toBe(200);
    expect(reports.status).toBe(200);
  });

  it('HARD limit staffMax=10 blocks the 11th staff with 403 LIMIT_REACHED', async () => {
    const token = await ownerToken();
    const res = await fetchJson(`${testApp.baseUrl}/team`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ name: 'Eleventh', identifier: 'eleventh@ent-fallback.test', role: 'stylist', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(res.body.data).toMatchObject({ code: 'LIMIT_REACHED', limitKey: 'staffMax', current: 10, limit: 10 });
  });

  it('SOFT limit appointmentsMonth notifies at 80% and 100%, deduplicated (real DB re-read)', async () => {
    const svc = testApp.app.get(EntitlementsService);
    const { runWithTenant } = require('../src/common/tenant/tenant-context');
    const ctx = { tenantId, locationId, locationIds: [locationId], role: 'owner', plan: 'starter', features: {}, limits: {} };
    await runWithTenant(ctx, () => svc.checkSoftLimit(tenantId, 'appointmentsMonth', 400, 500));
    await runWithTenant(ctx, () => svc.checkSoftLimit(tenantId, 'appointmentsMonth', 400, 500)); // repeat, must dedup
    await runWithTenant(ctx, () => svc.checkSoftLimit(tenantId, 'appointmentsMonth', 500, 500));

    const notifs = await testDb.db.collection('notifications').find({ salonId: tenantId, type: 'entitlements.quota_warning' }).toArray();
    expect(notifs).toHaveLength(2); // 80% + 100%, le doublon à 80% est dédupliqué
  });

  it('invalidate webhook 401s when CP_SHARED_SECRET-signed headers are missing (never 500, fails safe)', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/internal/entitlements/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    });
    expect(res.status).toBe(401);
  });
});

describe('entitlements (Prompt 7) — CP configured, real RS256 verification against a local mock CP', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let mockCp: http.Server;
  let publicKey: string;
  let privateKey: string;
  let wrongPrivateKey: string;

  const tenants: Record<string, string> = {};

  beforeAll(async () => {
    testDb = await startTestDb('entitlements_cp');
    ({ publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }));
    ({ privateKey: wrongPrivateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    }));

    const validSalon = await seedSalon(testDb.db, { slug: 'ent-cp-valid' });
    const expiredSalon = await seedSalon(testDb.db, { slug: 'ent-cp-expired' });
    const tamperedSalon = await seedSalon(testDb.db, { slug: 'ent-cp-tampered' });
    const mismatchSalon = await seedSalon(testDb.db, { slug: 'ent-cp-mismatch' });
    tenants.valid = validSalon.tenantId;
    tenants.expired = expiredSalon.tenantId;
    tenants.tampered = tamperedSalon.tenantId;
    tenants.mismatch = mismatchSalon.tenantId;
    for (const [key, id] of Object.entries(tenants)) {
      await seedStaff(testDb.db, {
        tenantId: id,
        role: 'owner',
        locationIds: [(key === 'valid' ? validSalon : key === 'expired' ? expiredSalon : key === 'tampered' ? tamperedSalon : mismatchSalon).locations[0].id],
        defaultLocationId: (key === 'valid' ? validSalon : key === 'expired' ? expiredSalon : key === 'tampered' ? tamperedSalon : mismatchSalon).locations[0].id,
      });
    }
    // Un 2e staff pour `valid` afin de saturer staffMax=2 du plan simulé.
    await seedStaff(testDb.db, { tenantId: tenants.valid, role: 'stylist', locationIds: [validSalon.locations[0].id], defaultLocationId: validSalon.locations[0].id });

    mockCp = http.createServer((req, res) => {
      const url = new URL(req.url ?? '', 'http://localhost');
      const match = url.pathname.match(/^\/internal\/entitlements\/(.+)$/);
      if (!match) return void res.writeHead(404).end();
      const reqTenantId = match[1];
      const signature = req.headers['x-cp-signature'] as string | undefined;
      const timestamp = req.headers['x-cp-timestamp'] as string | undefined;
      if (!signature || !timestamp) return void res.writeHead(401).end();
      const expected = crypto.createHmac('sha256', CP_SHARED_SECRET).update(`${timestamp}.${reqTenantId}`).digest('hex');
      if (expected !== signature) return void res.writeHead(401).end();

      const now = Math.floor(Date.now() / 1000);
      let token: string | null = null;
      if (reqTenantId === tenants.valid) {
        token = jwt.sign(
          {
            tenantId: reqTenantId,
            plan: 'pro',
            features: { pos: true, ecommerce: false, analytics: true, mobileApp: true, customDomain: false, api: false },
            limits: { staffMax: 2, locationsMax: 5, appointmentsMonth: 2000, smsQuota: 1000 },
            status: 'active',
            iat: now,
            exp: now + 3600,
          },
          privateKey,
          { algorithm: 'RS256' },
        );
      } else if (reqTenantId === tenants.expired) {
        token = jwt.sign({ tenantId: reqTenantId, plan: 'pro', features: { ecommerce: true }, limits: {}, status: 'active', iat: now - 7200, exp: now - 3600 }, privateKey, { algorithm: 'RS256' });
      } else if (reqTenantId === tenants.tampered) {
        token = jwt.sign({ tenantId: reqTenantId, plan: 'business', features: { ecommerce: true }, limits: {}, status: 'active', iat: now, exp: now + 3600 }, wrongPrivateKey, { algorithm: 'RS256' });
      } else if (reqTenantId === tenants.mismatch) {
        token = jwt.sign({ tenantId: 'not-the-requested-tenant', plan: 'business', features: {}, limits: {}, status: 'active', iat: now, exp: now + 3600 }, privateKey, { algorithm: 'RS256' });
      } else {
        return void res.writeHead(404).end();
      }
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ token }));
    });
    await new Promise<void>((resolve) => mockCp.listen(0, resolve));
    const port = (mockCp.address() as any).port;
    process.env.CP_URL = `http://127.0.0.1:${port}`;
    process.env.CP_PUBLIC_KEY = publicKey;

    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await new Promise<void>((resolve) => mockCp.close(() => resolve()));
    await stopTestDb(testDb);
    delete process.env.CP_URL;
    delete process.env.CP_PUBLIC_KEY;
  });

  async function tokenFor(tenantKey: keyof typeof tenants): Promise<string> {
    const tenantId = tenants[tenantKey];
    const staff = await testDb.db.collection('staffs').findOne({ salonId: tenantId, role: 'owner' });
    return signStaffJwt({ sub: staff!.userId.toString(), salonId: tenantId, role: 'owner', staffId: staff!._id.toString() });
  }

  it('valid RS256 JWT: plan "pro" with ecommerce=false → real 403 FEATURE_NOT_IN_PLAN', async () => {
    const token = await tokenFor('valid');
    const res = await fetchJson(`${testApp.baseUrl}/orders`, { headers: authHeader(token) });
    expect(res.status).toBe(403);
    expect(res.body.data).toMatchObject({ code: 'FEATURE_NOT_IN_PLAN', feature: 'ecommerce', currentPlan: 'pro' });
  });

  it('same verified JWT: plan "pro" with pos=true → 200 (different feature, same token)', async () => {
    const token = await tokenFor('valid');
    const res = await fetchJson(`${testApp.baseUrl}/pos/roster`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('valid RS256 JWT: plan "pro" staffMax=2 (already at 2) → real 403 LIMIT_REACHED', async () => {
    const token = await tokenFor('valid');
    const res = await fetchJson(`${testApp.baseUrl}/team`, {
      method: 'POST',
      headers: jsonHeaders(token),
      body: JSON.stringify({ name: 'Third', identifier: 'third@ent-cp.test', role: 'stylist', password: 'password123' }),
    });
    expect(res.status).toBe(403);
    expect(res.body.data).toMatchObject({ code: 'LIMIT_REACHED', limitKey: 'staffMax', limit: 2 });
  });

  it('expired JWT → falls back to starter (ecommerce=true) → 200, never blocked', async () => {
    const token = await tokenFor('expired');
    const res = await fetchJson(`${testApp.baseUrl}/orders`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('JWT signed with the wrong private key → falls back to starter → 200', async () => {
    const token = await tokenFor('tampered');
    const res = await fetchJson(`${testApp.baseUrl}/orders`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('JWT tenantId mismatch (payload.tenantId ≠ requested tenant) → falls back to starter → 200', async () => {
    const token = await tokenFor('mismatch');
    const res = await fetchJson(`${testApp.baseUrl}/orders`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
  });

  it('invalidate webhook: valid HMAC → 200; invalid HMAC → 401', async () => {
    const { signInternal } = require('./utils/test-app');
    const body = JSON.stringify({ tenantId: tenants.valid });
    const { signature, timestamp } = signInternal(body);
    const ok = await fetchJson(`${testApp.baseUrl}/internal/entitlements/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cp-signature': signature, 'x-cp-timestamp': timestamp },
      body,
    });
    expect([200, 201]).toContain(ok.status);

    const bad = await fetchJson(`${testApp.baseUrl}/internal/entitlements/invalidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-cp-signature': 'deadbeef'.repeat(8), 'x-cp-timestamp': timestamp },
      body,
    });
    expect(bad.status).toBe(401);
  });
});
