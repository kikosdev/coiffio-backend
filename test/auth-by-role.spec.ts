/**
 * LE FILET qui manquait (Prompt 9, cadrage explicite de l'utilisateur) : pour CHAQUE rôle,
 * login réel + au moins une requête authentifiée → ne doit JAMAIS 500. C'est le test qui
 * aurait attrapé d'un coup les deux bugs `TenantContextMiddleware` de ce sprint :
 *   - stylist/colorist 500 systématique (trouvé Prompt 4)
 *   - owner/manager/client 500 systématique (trouvé Prompt 7, `findAllForTenant` non
 *     enveloppé dans `runWithTenant` — corrigé dans ce même sprint)
 * Chaque cas ci-dessous est délibérément indépendant des autres : un seul rôle cassé ne doit
 * jamais masquer les six autres (pas de early-return partagé, pas de `beforeAll` fragile).
 */
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedClient,
  signStaffJwt,
  signClientJwt,
  signPosJwt,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('auth-by-role — no role 500s on login + one authenticated request', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;

  beforeAll(async () => {
    testDb = await startTestDb('auth_by_role');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'auth-role-salon' });
    tenantId = salon.tenantId;
    locationId = salon.locations[0].id;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('owner: login (JWT) + GET /locations → not 500', async () => {
    const { staffId, userId } = await seedStaff(testDb.db, { tenantId, role: 'owner', locationIds: [locationId], defaultLocationId: locationId });
    const token = signStaffJwt({ sub: userId, salonId: tenantId, role: 'owner', staffId });
    const res = await fetchJson(`${testApp.baseUrl}/locations`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('manager: login (JWT) + GET /locations → not 500', async () => {
    const { staffId, userId } = await seedStaff(testDb.db, { tenantId, role: 'manager', locationIds: [locationId], defaultLocationId: locationId });
    const token = signStaffJwt({ sub: userId, salonId: tenantId, role: 'manager', staffId });
    const res = await fetchJson(`${testApp.baseUrl}/locations`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('stylist: login (JWT) + GET /staff/today → not 500', async () => {
    const { staffId, userId } = await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [locationId], defaultLocationId: locationId });
    const token = signStaffJwt({ sub: userId, salonId: tenantId, role: 'stylist', staffId });
    const res = await fetchJson(`${testApp.baseUrl}/staff/today`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('colorist: login (JWT) + GET /staff/today → not 500', async () => {
    const { staffId, userId } = await seedStaff(testDb.db, { tenantId, role: 'colorist', locationIds: [locationId], defaultLocationId: locationId });
    const token = signStaffJwt({ sub: userId, salonId: tenantId, role: 'colorist', staffId });
    const res = await fetchJson(`${testApp.baseUrl}/staff/today`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('client: login (JWT) + GET /appointments/mine → not 500', async () => {
    const { clientId } = await seedClient(testDb.db, { tenantId, phone: '+21620111222' });
    // Même raccourci que le JWT ci-dessous (sub: clientId, pas un vrai users._id) : un
    // Membership doit exister pour ce (userId, tenantId), sinon TenantContextMiddleware
    // (Sprint 2 v2 Prompt 2) rejette 403 avant même d'atteindre la route.
    await testDb.db.collection('memberships').insertOne({
      userId: new ObjectId(clientId),
      tenantId,
      kind: 'client',
      clientId: new ObjectId(clientId),
      role: 'client',
      locationIds: [locationId],
      defaultLocationId: locationId,
      status: 'active',
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const token = signClientJwt({ sub: clientId, salonId: tenantId, clientId });
    const res = await fetchJson(`${testApp.baseUrl}/appointments/mine`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('guest (no JWT at all): GET /:salonSlug/book/services → not 500', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/auth-role-salon/book/services`);
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('POS: login (JWT scope=pos) + GET /pos/roster → not 500', async () => {
    const { staffId } = await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [locationId], defaultLocationId: locationId, posEnabled: true });
    const token = signPosJwt({ staffId, salonId: tenantId, role: 'stylist' });
    const res = await fetchJson(`${testApp.baseUrl}/pos/roster`, { headers: authHeader(token) });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(200);
  });

  it('regression guard: an unknown/garbage JWT never 500s either (401, not a crash)', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/locations`, { headers: authHeader('not-a-real-jwt') });
    expect(res.status).toBeLessThan(500);
  });

  // ── Régression : les VRAIS POST /auth/login, /auth/login-pin et /auth/register (jamais
  // un JWT pré-signé) — trouvés cassés le 2026-08-01 en peuplant une base de dev via l'API
  // de provisioning du Prompt 8. Les 3 méthodes cherchaient un staff/client par un champ
  // (userId, staffId) via les modèles Mongoose (`staffModel`/`clientModel`, TENANT_SCOPED)
  // AVANT qu'aucun tenant ne soit connu — ces routes n'ont par construction aucun JWT
  // préalable, donc `TenantContextMiddleware` n'y pose jamais de contexte. 500 systématique
  // ("No tenant context available"), jamais attrapé par les tests ci-dessus car ils signent
  // tous un JWT directement au lieu d'appeler ces vrais endpoints.
  // Corrigés selon que le tenant est dérivable AVANT le lookup scopé ou pas :
  //   - login()/loginPin() : le tenant n'est connu QU'EN lisant la ligne scopée elle-même
  //     (userId/staffId seuls ne le révèlent pas) — chicken-and-egg réel, lecture initiale
  //     via le driver Mongo natif (`connection.collection(...)`, qui ne passe pas par le
  //     plugin). loginPin() bascule ensuite sur `runWithTenant(bootstrapCtx(...))` pour ses
  //     écritures (pinAttempts/pinLockedUntil) dès que le tenant est connu, pour garder les
  //     hooks/validation Mongoose là où c'est possible.
  //   - register() : `resolveSalonId()` ne lit que `salons` (UNSCOPED) — le tenant est
  //     connu SANS lookup scopé, donc tout le corps tourne sous
  //     `runWithTenant(bootstrapCtx(salonId))`, qui garde les modèles Mongoose intacts.
  // Ces 4 tests appellent les VRAIS endpoints pour que ça ne puisse plus jamais régresser
  // en silence.

  // Sprint 2 v2 — Prompt 7 : pour CHAQUE rôle, un vrai login (jamais un JWT pré-signé) doit
  // produire un token dont `memberships[]` reflète correctement ce rôle — pas seulement
  // "pas de 500" (déjà couvert au-dessus via des JWT pré-signés, qui n'exercent PAS
  // `issueToken()` lui-même). Décode le VRAI JWT à chaque fois.
  function assertMembershipsClaim(token: string, expectedTenantId: string, expectedRole: string): void {
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.salonId).toBeUndefined();
    expect(decoded.role).toBeUndefined();
    const memberships = decoded.memberships as Array<{ tenantId: string; role: string }> | undefined;
    expect(Array.isArray(memberships)).toBe(true);
    expect(memberships).toHaveLength(1);
    expect(memberships![0].tenantId).toBe(expectedTenantId);
    expect(memberships![0].role).toBe(expectedRole);
  }

  it('real POST /auth/login for a staff account (owner) never 500s, returns a usable token with the correct memberships[]', async () => {
    const { userId } = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
      identifier: 'real-login-owner@test.local',
    });
    await testDb.db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { passwordHash: bcrypt.hashSync('RealPass123!', 4) } });

    const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'real-login-owner@test.local', password: 'RealPass123!' }),
    });
    expect(loginRes.status).toBeLessThan(500);
    expect(loginRes.status).toBe(201);
    const token = loginRes.body.data.token as string;
    assertMembershipsClaim(token, tenantId, 'owner');

    const meRes = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
  });

  it.each([
    ['manager', 'real-login-manager@test.local'],
    ['stylist', 'real-login-stylist@test.local'],
    ['colorist', 'real-login-colorist@test.local'],
  ] as const)('real POST /auth/login for a %s account never 500s, returns a usable token with the correct memberships[]', async (role, identifier) => {
    const { userId } = await seedStaff(testDb.db, {
      tenantId, role, locationIds: [locationId], defaultLocationId: locationId, identifier,
    });
    await testDb.db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { passwordHash: bcrypt.hashSync('RealPass123!', 4) } });

    const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password: 'RealPass123!' }),
    });
    expect(loginRes.status).toBeLessThan(500);
    expect(loginRes.status).toBe(201);
    const token = loginRes.body.data.token as string;
    assertMembershipsClaim(token, tenantId, role);

    // users.role n'est QUE le bucket générique — jamais le rôle applicatif réel.
    const userDoc = await testDb.db.collection('users').findOne({ _id: new ObjectId(userId) });
    expect(userDoc?.role).toBe('staff');
    expect(userDoc?.role).not.toBe(role);

    const meRes = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
    expect(meRes.body.data.role).toBe(role);
  });

  it('real POST /auth/login for a client account never 500s, returns a usable token with the correct memberships[]', async () => {
    const userId = new ObjectId();
    await testDb.db.collection('users').insertOne({
      _id: userId,
      identifier: 'real-login-client@test.local',
      identifierType: 'email',
      passwordHash: bcrypt.hashSync('RealPass123!', 4),
      role: 'client',
      isActive: true,
    });
    await seedClient(testDb.db, { tenantId, phone: '+21620111333', userId: userId.toString() });

    const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: 'real-login-client@test.local', password: 'RealPass123!' }),
    });
    expect(loginRes.status).toBeLessThan(500);
    expect(loginRes.status).toBe(201);
    const token = loginRes.body.data.token as string;
    assertMembershipsClaim(token, tenantId, 'client');

    const meRes = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
  });

  it('real POST /auth/login-pin (POS) never 500s and returns a usable token', async () => {
    const { staffId } = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
      posEnabled: true,
    });
    await testDb.db.collection('staffs').updateOne({ _id: new ObjectId(staffId) }, { $set: { pinHash: bcrypt.hashSync('1234', 4) } });

    const pinRes = await fetchJson(`${testApp.baseUrl}/auth/login-pin`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ staffId, pin: '1234' }),
    });
    expect(pinRes.status).toBeLessThan(500);
    expect(pinRes.status).toBe(201);
    expect(pinRes.body.data.token).toBeTruthy();

    // Relu depuis la base : pinAttempts bien remis à 0 par l'écriture faite sous
    // runWithTenant, pas juste "pas de 500" en surface.
    const staffAfter = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(staffId) });
    expect(staffAfter?.pinAttempts).toBe(0);
  });

  it('real POST /auth/register (client self-service) never 500s and returns a usable token', async () => {
    // Sprint 2 v2 Prompt 4 : plus de fallback DEFAULT_SALON_ID — register() a besoin d'un
    // salon résolu (sous-domaine ou salonSlug explicite), sinon 404 propre (voir le test
    // dédié ci-dessous). En localhost/test, aucun sous-domaine réel : `salonSlug` explicite.
    const registerRes = await fetchJson(`${testApp.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Real Register Client',
        identifier: 'real-register-client@test.local',
        phone: '+21620111444',
        password: 'RealPass123!',
        salonSlug: 'auth-role-salon',
      }),
    });
    expect(registerRes.status).toBeLessThan(500);
    expect(registerRes.status).toBe(201);
    const token = registerRes.body.data.token as string;

    const meRes = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(meRes.status).toBe(200);
  });

  it('real POST /auth/register WITHOUT a resolvable salon (no subdomain, no salonSlug) → 404, no silent fallback', async () => {
    const registerRes = await fetchJson(`${testApp.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Salon Client',
        identifier: 'real-register-no-salon@test.local',
        phone: '+21620111555',
        password: 'RealPass123!',
      }),
    });
    expect(registerRes.status).toBeLessThan(500);
    expect(registerRes.status).toBe(404);
  });
});
