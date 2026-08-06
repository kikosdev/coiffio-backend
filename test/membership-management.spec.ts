/**
 * Sprint 2 v2 Prompt 3 — Owner multi-tenant (Option B) + gestion des memberships.
 * `grant()` n'a pas d'endpoint HTTP dédié dans ce prompt (le SKILL n'en liste aucun pour
 * Prompt 3 — Prompt 5/invitations l'appellera) : prouvé par appel direct du service, comme
 * la migration au Prompt 1. Les endpoints réellement exposés (`/me/switch-tenant`,
 * `/team/:id/membership`, `/team/:id/locations`, `/team/:id/access`) sont prouvés en vrai
 * HTTP, relu depuis la base à chaque fois (jamais l'objet retourné).
 */
import { ObjectId } from 'mongodb';
import * as bcrypt from 'bcryptjs';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  signStaffJwt,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { MembershipService } from '../src/identity/membership.service';

describe('membership-management (Sprint 2 v2 Prompt 3)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let memberships: MembershipService;
  let tenantA: string;
  let tenantB: string;
  let locA: string;
  let locB: string;

  beforeAll(async () => {
    testDb = await startTestDb('membership_management');
    testApp = await bootApp();
    memberships = testApp.app.get(MembershipService);

    const salonA = await seedSalon(testDb.db, { slug: 'mm-tenant-a' });
    const salonB = await seedSalon(testDb.db, { slug: 'mm-tenant-b' });
    tenantA = salonA.tenantId;
    tenantB = salonB.tenantId;
    locA = salonA.locations[0].id;
    locB = salonB.locations[0].id;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  // ── Index composite {userId,salonId} ────────────────────────────────────────
  describe('index composite staffs.{userId,salonId}', () => {
    it('rejette un 2e profil MEME (userId, salonId) ; accepte MEME userId, AUTRE salonId', async () => {
      const userId = new ObjectId();
      const base = {
        userId,
        name: 'Index Proof',
        email: '',
        phone: '',
        role: 'stylist',
        color: '#000',
        isActive: true,
        locationIds: [],
        acceptingBookings: true,
        posEnabled: false,
        publicProfile: { visible: true, order: 0 },
      };
      await testDb.db.collection('staffs').insertOne({ ...base, salonId: tenantA });

      await expect(testDb.db.collection('staffs').insertOne({ ...base, salonId: tenantA })).rejects.toMatchObject({ code: 11000 });
      await expect(testDb.db.collection('staffs').insertOne({ ...base, salonId: tenantB })).resolves.toBeDefined();

      const count = await testDb.db.collection('staffs').countDocuments({ userId });
      expect(count).toBe(2);
    });
  });

  // ── grant() ──────────────────────────────────────────────────────────────────
  // Note (Prompt 7) : le flux nominal "2 memberships, nouveau profil staff, _id d'origine
  // inchangé" et "manager → owner refusé" sont désormais ID-14/ID-08 dans
  // `identity-multitenant.spec.ts` (suite canonique) — retirés d'ici pour éviter la
  // duplication. Ce qui reste ici est spécifique à ce prompt (règle de doublon).
  describe('MembershipService.grant()', () => {
    it('grant() refuse un doublon (userId, tenantId) déjà membre', async () => {
      const stylist = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-grant-dup@test.local' });
      await expect(
        memberships.grant('owner', { userId: stylist.userId, tenantId: tenantA, role: 'manager', locationIds: [locA] }),
      ).rejects.toMatchObject({ status: 409 });
    });
  });

  // ── LAST_OWNER ───────────────────────────────────────────────────────────────
  // Note (Prompt 7) : le cas "dernier owner → 409 LAST_OWNER" est ID-07 dans
  // `identity-multitenant.spec.ts` — retiré d'ici. Le cas "non-dernier → succès" reste, il
  // n'est pas un des 14 cas numérotés.
  describe('revoke() — LAST_OWNER', () => {
    it('DELETE /team/:id/access sur un owner NON-dernier → 200, révoqué, relu base', async () => {
      const salon = await seedSalon(testDb.db, { slug: 'mm-two-owners' });
      const loc = salon.locations[0].id;
      const ownerKeep = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [loc], defaultLocationId: loc });
      const ownerLeave = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [loc], defaultLocationId: loc });
      const token = signStaffJwt({ sub: ownerKeep.userId, salonId: salon.tenantId, role: 'owner', staffId: ownerKeep.staffId });

      const res = await fetchJson(`${testApp.baseUrl}/team/${ownerLeave.staffId}/access`, { method: 'DELETE', headers: authHeader(token) });
      expect(res.status).toBe(200);

      const revoked = await testDb.db.collection('memberships').findOne({ staffId: new ObjectId(ownerLeave.staffId) });
      expect(revoked?.status).toBe('revoked');
      expect(revoked?.revokedAt).toBeTruthy();
    });
  });

  // ── /me/switch-tenant ────────────────────────────────────────────────────────
  describe('POST /me/switch-tenant', () => {
    it('tenant valide → 201, membership du tenant renvoyé', async () => {
      const staffA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-switch-a@test.local' });
      await memberships.grant('owner', { userId: staffA.userId, tenantId: tenantB, role: 'manager', locationIds: [locB], defaultLocationId: locB });
      const token = signStaffJwt({ sub: staffA.userId, salonId: tenantA, role: 'stylist', staffId: staffA.staffId });

      const res = await fetchJson(`${testApp.baseUrl}/auth/me/switch-tenant`, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantB }),
      });
      expect(res.status).toBe(201);
      expect(res.body.data.tenantId).toBe(tenantB);
      expect(res.body.data.role).toBe('manager');
      expect(res.body.data.token).toBeTruthy();
    });

    it('vrai token memberships[] (login réel, pas un JWT legacy pré-signé) : multi-membership sans X-Tenant-Id → 400 ; avec X-Tenant-Id=tenant courant → switch OK', async () => {
      // Piège trouvé via la preuve live sur multitenant : `signStaffJwt` (legacy, payload.
      // salonId racine) résout TOUJOURS un candidat sans ambiguïté, contournant le VRAI
      // chemin memberships[] — un token neuf multi-membership a besoin d'un X-Tenant-Id
      // pour passer le middleware, MÊME pour appeler switch-tenant lui-même (la résolution
      // du tenant actif a lieu AVANT le contrôleur, sur TOUTE route sans exception).
      const identifier = 'mm-switch-real-login@test.local';
      const password = 'RealPass123!';
      const staffA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [locA], defaultLocationId: locA, identifier });
      await testDb.db.collection('users').updateOne({ _id: new ObjectId(staffA.userId) }, { $set: { passwordHash: bcrypt.hashSync(password, 4) } });
      await memberships.grant('owner', { userId: staffA.userId, tenantId: tenantB, role: 'manager', locationIds: [locB], defaultLocationId: locB });

      const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password }),
      });
      expect(loginRes.status).toBe(201);
      const token = loginRes.body.data.token as string;

      const noHeaderRes = await fetchJson(`${testApp.baseUrl}/auth/me/switch-tenant`, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantB }),
      });
      expect(noHeaderRes.status).toBe(400);
      expect(noHeaderRes.body.data?.code).toBe('TENANT_REQUIRED');

      const withHeaderRes = await fetchJson(`${testApp.baseUrl}/auth/me/switch-tenant`, {
        method: 'POST',
        headers: { ...authHeader(token), 'x-tenant-id': tenantA, 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: tenantB }),
      });
      expect(withHeaderRes.status).toBe(201);
      expect(withHeaderRes.body.data.tenantId).toBe(tenantB);
      expect(withHeaderRes.body.data.role).toBe('manager');
    });

    it('tenant sans membership → 403', async () => {
      const staffA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-switch-noaccess@test.local' });
      const foreignSalon = await seedSalon(testDb.db, { slug: 'mm-switch-foreign' });
      const token = signStaffJwt({ sub: staffA.userId, salonId: tenantA, role: 'stylist', staffId: staffA.staffId });

      const res = await fetchJson(`${testApp.baseUrl}/auth/me/switch-tenant`, {
        method: 'POST',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ tenantId: foreignSalon.tenantId }),
      });
      expect(res.status).toBe(403);
    });
  });

  // ── GET /me/memberships ─────────────────────────────────────────────────────
  it('GET /me/memberships liste les tenants (nom/slug/role) du user courant', async () => {
    const staff = await seedStaff(testDb.db, { tenantId: tenantA, role: 'colorist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-list-memberships@test.local' });
    await memberships.grant('owner', { userId: staff.userId, tenantId: tenantB, role: 'stylist', locationIds: [locB], defaultLocationId: locB });
    const token = signStaffJwt({ sub: staff.userId, salonId: tenantA, role: 'colorist', staffId: staff.staffId });

    const res = await fetchJson(`${testApp.baseUrl}/auth/me/memberships`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    const list = res.body.data as Array<{ tenantId: string; tenantSlug: string; role: string }>;
    expect(list).toHaveLength(2);
    const bySlug = new Map(list.map((m) => [m.tenantSlug, m.role]));
    expect(bySlug.get('mm-tenant-a')).toBe('colorist');
    expect(bySlug.get('mm-tenant-b')).toBe('stylist');
  });

  // ── PATCH /team/:id/locations ───────────────────────────────────────────────
  describe('PATCH /team/:id/locations', () => {
    it('locations hors tenant → 400 ; locations valides → 200, mirroré sur staffs.locationIds', async () => {
      const owner = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-loc-owner@test.local' });
      const target = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-loc-target@test.local' });
      const token = signStaffJwt({ sub: owner.userId, salonId: tenantA, role: 'owner', staffId: owner.staffId });

      const badRes = await fetchJson(`${testApp.baseUrl}/team/${target.staffId}/locations`, {
        method: 'PATCH',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationIds: [locB] }), // locB appartient à tenantB, pas A
      });
      expect(badRes.status).toBe(400);

      const goodRes = await fetchJson(`${testApp.baseUrl}/team/${target.staffId}/locations`, {
        method: 'PATCH',
        headers: { ...authHeader(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ locationIds: [locA] }),
      });
      expect(goodRes.status).toBe(200);

      const staffAfter = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(target.staffId) });
      expect(staffAfter?.locationIds).toEqual([locA]);
      const membershipAfter = await testDb.db.collection('memberships').findOne({ staffId: new ObjectId(target.staffId) });
      expect(membershipAfter?.locationIds).toEqual([locA]);
    });
  });

  // ── GET /team/:id/membership ────────────────────────────────────────────────
  it('GET /team/:id/membership renvoie le membership ; staffId hors tenant → 404', async () => {
    const owner = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-get-owner@test.local' });
    const target = await seedStaff(testDb.db, { tenantId: tenantA, role: 'manager', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-get-target@test.local' });
    const foreignStaff = await seedStaff(testDb.db, { tenantId: tenantB, role: 'stylist', locationIds: [locB], defaultLocationId: locB, identifier: 'mm-get-foreign@test.local' });
    const token = signStaffJwt({ sub: owner.userId, salonId: tenantA, role: 'owner', staffId: owner.staffId });

    const okRes = await fetchJson(`${testApp.baseUrl}/team/${target.staffId}/membership`, { headers: authHeader(token) });
    expect(okRes.status).toBe(200);
    expect(okRes.body.data.role).toBe('manager');

    const crossTenantRes = await fetchJson(`${testApp.baseUrl}/team/${foreignStaff.staffId}/membership`, { headers: authHeader(token) });
    expect(crossTenantRes.status).toBe(404);
  });

  // ── deactivateMe() — scopé au tenant actif ──────────────────────────────────
  describe('PATCH /auth/me/deactivate — scopé au tenant actif (Prompt 3)', () => {
    it('désactiver depuis le tenant B ne touche pas le membership actif du tenant A', async () => {
      const staffA = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA], defaultLocationId: locA, identifier: 'mm-deactivate-scope@test.local' });
      await memberships.grant('owner', { userId: staffA.userId, tenantId: tenantB, role: 'manager', locationIds: [locB], defaultLocationId: locB });
      const tokenB = signStaffJwt({ sub: staffA.userId, salonId: tenantB, role: 'manager', staffId: staffA.staffId });

      const res = await fetchJson(`${testApp.baseUrl}/auth/me/deactivate`, { method: 'PATCH', headers: authHeader(tokenB) });
      expect(res.status).toBe(200);

      const membershipB = await testDb.db.collection('memberships').findOne({ userId: new ObjectId(staffA.userId), tenantId: tenantB });
      expect(membershipB?.status).toBe('revoked');
      const membershipA = await testDb.db.collection('memberships').findOne({ userId: new ObjectId(staffA.userId), tenantId: tenantA });
      expect(membershipA?.status).toBe('active'); // intact

      const user = await testDb.db.collection('users').findOne({ _id: new ObjectId(staffA.userId) });
      expect(user?.isActive).toBe(true); // plus de kill-switch global
    });

    it('un owner seul se désactivant lui-même → 409 LAST_OWNER (hérite de revoke())', async () => {
      const salon = await seedSalon(testDb.db, { slug: 'mm-deactivate-last-owner' });
      const sole = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [salon.locations[0].id], defaultLocationId: salon.locations[0].id });
      const token = signStaffJwt({ sub: sole.userId, salonId: salon.tenantId, role: 'owner', staffId: sole.staffId });

      const res = await fetchJson(`${testApp.baseUrl}/auth/me/deactivate`, { method: 'PATCH', headers: authHeader(token) });
      expect(res.status).toBe(409);
      expect(res.body.data?.code).toBe('LAST_OWNER');
    });
  });

  // ── Impact disponibilité : révoquer un membership retire du storefront ─────
  it('révoquer le membership d\'un stylist le retire de /availability (public, guest)', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'mm-availability-impact' });
    const loc = salon.locations[0].id;
    const service = new ObjectId();
    await testDb.db.collection('services').insertOne({ _id: service, salonId: salon.tenantId, name: 'Coupe', category: 'Cheveux', gender: 'universal', price: 30, durationMin: 30, active: true });
    const stylist = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'stylist', locationIds: [loc], defaultLocationId: loc, name: 'Availability Stylist' });
    const dateIso = new Date().toISOString().slice(0, 10);
    // weekday en UTC depuis la date, comme `weekdayOf()` (availability.util.ts) — jamais
    // `Date.getDay()` (fuseau local du runner), qui peut diverger du calcul du moteur.
    const weekday = new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
    await testDb.db.collection('staffs').updateOne(
      { _id: new ObjectId(stylist.staffId) },
      { $set: { week: [{ day: weekday, start: '00:00', end: '23:59', breaks: [] }] } },
    );
    const before = await fetchJson(`${testApp.baseUrl}/${salon.slug}/availability?serviceId=${service.toString()}&date=${dateIso}`);
    expect(before.status).toBe(200);
    const namesBefore = (before.body.data as Array<{ stylistId: string }>).map((s) => s.stylistId);
    expect(namesBefore).toContain(stylist.staffId);

    const membership = await testDb.db.collection('memberships').findOne({ staffId: new ObjectId(stylist.staffId) });
    await memberships.revoke(membership!._id.toString());

    const after = await fetchJson(`${testApp.baseUrl}/${salon.slug}/availability?serviceId=${service.toString()}&date=${dateIso}`);
    expect(after.status).toBe(200);
    const namesAfter = (after.body.data as Array<{ stylistId: string }>).map((s) => s.stylistId);
    expect(namesAfter).not.toContain(stylist.staffId);
  });
});
