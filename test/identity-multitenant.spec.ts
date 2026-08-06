/**
 * Sprint 2 v2 — Prompt 7 (consolidation finale, verrouille le sprint, même rôle que
 * `auth-by-role.spec.ts` pour le Sprint 1 v2/Prompt 9). Les 14 cas ID-01..14 du SKILL v2,
 * NOMMÉS explicitement, dans UN SEUL fichier canonique.
 *
 * Consolidation, pas duplication : plusieurs cas ci-dessous existaient déjà, textuellement
 * identiques, dans `membership-management.spec.ts` (ID-07, ID-08, ID-14),
 * `tenant-resolution.spec.ts` (ID-12, ID-13) et `invitations.spec.ts` (ID-11) — DÉPLACÉS
 * ici et RETIRÉS de leurs fichiers d'origine (jamais la même assertion à deux endroits).
 * Ces fichiers d'origine gardent tout ce qui n'est PAS un des 14 cas numérotés
 * (implémentation détaillée : index composite, PATCH /team/:id/locations, staffMax upsell,
 * rollback transactionnel, extractTenantSlugFromHost, etc.) — toujours utile, juste pas
 * "canonique Prompt 7".
 *
 * Fixture principale : U1 = owner tenant A + coloriste tenant B (2 memberships kind='staff'
 * — le cas nommé littéralement par le SKILL, possible depuis Prompt 3 : l'index composite
 * {userId,salonId} a levé le blocage qui forçait Prompt 2 à contourner avec un membership
 * kind='client'). U2 = stylist tenant A, `locationIds` restreint à A1 seul (tenant A a A1+A2)
 * — sert à la fois ID-05 (hors périmètre location) et ID-10 (role du membership ≠ users.role,
 * users.role d'un staff est TOUJOURS le bucket générique 'staff', jamais 'stylist').
 */
import * as bcrypt from 'bcryptjs';
import * as jwt from 'jsonwebtoken';
import * as crypto from 'crypto';
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  signStaffJwt,
  signPosJwt,
  fetchJson,
  authHeader,
  TestDb,
  TestApp,
} from './utils/test-app';
import { MembershipService } from '../src/identity/membership.service';

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

describe('identity-multitenant (Sprint 2 v2 — Prompt 7, ID-01..14)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let memberships: MembershipService;
  let tenantA: string;
  let tenantB: string;
  let locA1: string;
  let locA2: string;
  let locB1: string;

  const u1Identifier = 'idmt-u1@test.local';
  const u1Password = 'RealPass123!';
  let u1UserId: ObjectId;

  const u2Identifier = 'idmt-u2-stylist@test.local';
  let u2UserId: ObjectId;
  let u2StaffId: ObjectId;

  beforeAll(async () => {
    testDb = await startTestDb('identity_multitenant');
    testApp = await bootApp();
    memberships = testApp.app.get(MembershipService);

    const salonA = await seedSalon(testDb.db, { slug: 'idmt-tenant-a', locationSlugs: ['a1', 'a2'] });
    const salonB = await seedSalon(testDb.db, { slug: 'idmt-tenant-b' });
    tenantA = salonA.tenantId;
    tenantB = salonB.tenantId;
    locA1 = salonA.locations[0].id;
    locA2 = salonA.locations[1].id;
    locB1 = salonB.locations[0].id;

    // U1 = owner tenant A + coloriste tenant B — 2 memberships kind='staff', le cas littéral
    // du SKILL (débloqué par l'index composite {userId,salonId} du Prompt 3).
    u1UserId = new ObjectId();
    await testDb.db.collection('users').insertOne({
      _id: u1UserId, identifier: u1Identifier, identifierType: 'email',
      passwordHash: bcrypt.hashSync(u1Password, 4), role: 'owner', isActive: true,
    });
    const staffA1Id = new ObjectId();
    await testDb.db.collection('staffs').insertOne({
      _id: staffA1Id, salonId: tenantA, userId: u1UserId, name: 'U1 Owner A', email: u1Identifier, phone: '',
      role: 'owner', color: '#B89968', isActive: true, locationIds: [locA1, locA2], defaultLocationId: locA1,
      acceptingBookings: true, posEnabled: false, publicProfile: { visible: true, order: 0 },
    });
    await testDb.db.collection('memberships').insertOne({
      userId: u1UserId, tenantId: tenantA, kind: 'staff', staffId: staffA1Id, role: 'owner',
      locationIds: [locA1, locA2], defaultLocationId: locA1, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    });
    const staffB1Id = new ObjectId();
    await testDb.db.collection('staffs').insertOne({
      _id: staffB1Id, salonId: tenantB, userId: u1UserId, name: 'U1 Colorist B', email: '', phone: '',
      role: 'colorist', color: '#B89968', isActive: true, locationIds: [locB1], defaultLocationId: locB1,
      acceptingBookings: true, posEnabled: false, publicProfile: { visible: true, order: 0 },
    });
    await testDb.db.collection('memberships').insertOne({
      userId: u1UserId, tenantId: tenantB, kind: 'staff', staffId: staffB1Id, role: 'colorist',
      locationIds: [locB1], defaultLocationId: locB1, status: 'active', createdAt: new Date(), updatedAt: new Date(),
    });

    // U2 = stylist tenant A, restreint à A1 (tenant A a A1+A2) — ID-05 (hors périmètre
    // location) et ID-10 (role du membership, jamais users.role — le bucket générique
    // 'staff' de users.role ne dit RIEN du rôle applicatif réel).
    const u2 = await seedStaff(testDb.db, {
      tenantId: tenantA, role: 'stylist', locationIds: [locA1], defaultLocationId: locA1, identifier: u2Identifier,
    });
    u2UserId = new ObjectId(u2.userId);
    u2StaffId = new ObjectId(u2.staffId);
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function loginU1(): Promise<string> {
    const res = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: u1Identifier, password: u1Password }),
    });
    expect(res.status).toBe(201);
    return res.body.data.token as string;
  }

  it('ID-01: login → token porte memberships[], AUCUN salonId/role racine', async () => {
    const token = await loginU1();
    const decoded = jwt.decode(token) as Record<string, unknown>;
    expect(decoded.salonId).toBeUndefined();
    expect(decoded.role).toBeUndefined();
    expect(Array.isArray(decoded.memberships)).toBe(true);
    const membershipsClaim = decoded.memberships as Array<{ tenantId: string; role: string }>;
    expect(membershipsClaim).toHaveLength(2);
    const byTenant = new Map(membershipsClaim.map((m) => [m.tenantId, m.role]));
    expect(byTenant.get(tenantA)).toBe('owner');
    expect(byTenant.get(tenantB)).toBe('colorist');
  });

  it('ID-02: 2 memberships sans X-Tenant-Id → 400 TENANT_REQUIRED + liste des memberships', async () => {
    const token = await loginU1();
    const res = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(res.status).toBe(400);
    expect(res.body.data?.code).toBe('TENANT_REQUIRED');
    const list = res.body.data.memberships as Array<{ tenantId: string; role: string }>;
    expect(list.map((m) => m.tenantId).sort()).toEqual([tenantA, tenantB].sort());
  });

  it('ID-03: X-Tenant-Id=A → role=owner ; X-Tenant-Id=B → role=colorist', async () => {
    const token = await loginU1();
    const resA = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: { ...authHeader(token), 'x-tenant-id': tenantA } });
    expect(resA.status).toBe(200);
    expect(resA.body.data.role).toBe('owner');
    expect(resA.body.data.salonId).toBe(tenantA);

    const resB = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: { ...authHeader(token), 'x-tenant-id': tenantB } });
    expect(resB.status).toBe(200);
    expect(resB.body.data.role).toBe('colorist');
    expect(resB.body.data.salonId).toBe(tenantB);
  });

  it('ID-04: X-Tenant-Id vers un tenant sans membership → 403 TENANT_FORBIDDEN', async () => {
    const token = await loginU1();
    const salonC = await seedSalon(testDb.db, { slug: 'idmt-tenant-c' });
    const res = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: { ...authHeader(token), 'x-tenant-id': salonC.tenantId } });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBe('TENANT_FORBIDDEN');
  });

  it('ID-05: X-Location-Id hors locationIds du membership → 403 LOCATION_OUT_OF_SCOPE (U2, restreint à A1, demande A2)', async () => {
    const token = signStaffJwt({ sub: u2UserId.toString(), salonId: tenantA, role: 'stylist', staffId: u2StaffId.toString() });
    const res = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: { ...authHeader(token), 'x-location-id': locA2 } });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBe('LOCATION_OUT_OF_SCOPE');

    // Sa propre location (A1) reste autorisée — le 403 est bien lié au périmètre, pas au token.
    const okRes = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: { ...authHeader(token), 'x-location-id': locA1 } });
    expect(okRes.status).toBe(200);
  });

  it('ID-06: révoquer un membership → la requête suivante échoue immédiatement (cache invalidé, jamais ≤60s de retard)', async () => {
    // Membership et staff dédiés à ce test (isolé — une révocation ne doit pas affecter U2
    // ailleurs dans ce fichier).
    const target = await seedStaff(testDb.db, {
      tenantId: tenantA, role: 'stylist', locationIds: [locA1], defaultLocationId: locA1, identifier: 'idmt-id06-revoke-target@test.local',
    });
    const targetToken = signStaffJwt({ sub: target.userId, salonId: tenantA, role: 'stylist', staffId: target.staffId });

    const before = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(targetToken) });
    expect(before.status).toBe(200);

    const ownerToken = await loginU1();
    const revokeRes = await fetchJson(`${testApp.baseUrl}/team/${target.staffId}/access`, {
      method: 'DELETE',
      headers: { ...authHeader(ownerToken), 'x-tenant-id': tenantA },
    });
    expect(revokeRes.status).toBe(200);

    // Même token, même requête — sans aucune attente : revoke() invalide le cache
    // synchroniquement (`invalidateCache`), donc la propagation n'a pas besoin des 60s de TTL.
    const after = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(targetToken) });
    expect([401, 403]).toContain(after.status);

    const membershipAfter = await testDb.db.collection('memberships').findOne({ staffId: new ObjectId(target.staffId) });
    expect(membershipAfter?.status).toBe('revoked');
  });

  it('ID-07: révoquer le dernier owner actif d\'un tenant → 409 LAST_OWNER', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'idmt-id07-last-owner' });
    const sole = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [salon.locations[0].id], defaultLocationId: salon.locations[0].id });
    const token = signStaffJwt({ sub: sole.userId, salonId: salon.tenantId, role: 'owner', staffId: sole.staffId });

    const res = await fetchJson(`${testApp.baseUrl}/team/${sole.staffId}/access`, { method: 'DELETE', headers: authHeader(token) });
    expect(res.status).toBe(409);
    expect(res.body.data?.code).toBe('LAST_OWNER');

    const stillActive = await testDb.db.collection('memberships').findOne({ staffId: new ObjectId(sole.staffId) });
    expect(stillActive?.status).toBe('active');
  });

  it('ID-08: manager tentant de créer/accorder un owner → 403 (assertCanGrantRole, via grant())', async () => {
    const manager = await seedStaff(testDb.db, { tenantId: tenantA, role: 'manager', locationIds: [locA1], defaultLocationId: locA1, identifier: 'idmt-id08-manager@test.local' });
    const targetSalon = await seedSalon(testDb.db, { slug: 'idmt-id08-target' });
    await expect(
      memberships.grant('manager', { userId: manager.userId, tenantId: targetSalon.tenantId, role: 'owner', locationIds: [] }),
    ).rejects.toMatchObject({ status: 403 });

    const created = await testDb.db.collection('memberships').findOne({ userId: new ObjectId(manager.userId), tenantId: targetSalon.tenantId });
    expect(created).toBeNull();
  });

  it('ID-09: login PIN (POS) → mono-tenant, X-Tenant-Id divergent ignoré', async () => {
    const stylist = await seedStaff(testDb.db, {
      tenantId: tenantA, role: 'stylist', locationIds: [locA1], defaultLocationId: locA1, posEnabled: true, identifier: 'idmt-id09-pos-stylist@test.local',
    });
    // Staff distinct sur B, sans rapport avec le token POS — sert à prouver qu'il ne fuite
    // jamais dans un roster verrouillé sur A, même avec x-tenant-id: B.
    await seedStaff(testDb.db, {
      tenantId: tenantB, role: 'stylist', locationIds: [locB1], defaultLocationId: locB1, identifier: 'idmt-id09-tenant-b-decoy@test.local', name: 'Tenant B Decoy Stylist',
    });
    const posToken = signPosJwt({ staffId: stylist.staffId, salonId: tenantA, role: 'stylist' });
    const res = await fetchJson(`${testApp.baseUrl}/pos/roster`, { headers: { ...authHeader(posToken), 'x-tenant-id': tenantB } });
    expect(res.status).toBe(200);
    const names = (res.body.data as Array<{ name: string }>).map((s) => s.name);
    expect(names).not.toContain('Tenant B Decoy Stylist');
  });

  it("ID-10: le rôle du contexte vient du membership actif, JAMAIS de users.role (prouvé avec un stylist — users.role n'est que le bucket générique 'staff')", async () => {
    const userDoc = await testDb.db.collection('users').findOne({ _id: u2UserId });
    expect(userDoc?.role).toBe('staff'); // le bucket large, PAS le rôle applicatif

    const token = signStaffJwt({ sub: u2UserId.toString(), salonId: tenantA, role: 'stylist', staffId: u2StaffId.toString() });
    const res = await fetchJson(`${testApp.baseUrl}/auth/me`, { headers: authHeader(token) });
    expect(res.status).toBe(200);
    expect(res.body.data.role).toBe('stylist'); // vient du Membership, divergent de users.role
    expect(res.body.data.role).not.toBe(userDoc?.role);
  });

  it('ID-11: invitation acceptée par un user déjà existant (autre tenant) → réutilise le User, crée un 2e Membership (Option B côté staff)', async () => {
    const identifier = 'idmt-id11-cross-tenant@test.local';
    const password = 'CrossTenantPass123!';
    const existing = await seedStaff(testDb.db, { tenantId: tenantA, role: 'stylist', locationIds: [locA1], defaultLocationId: locA1, identifier });
    await testDb.db.collection('users').updateOne({ _id: new ObjectId(existing.userId) }, { $set: { passwordHash: bcrypt.hashSync(password, 4) } });

    const salonD = await seedSalon(testDb.db, { slug: 'idmt-id11-tenant-d' });
    const rawToken = crypto.randomBytes(32).toString('hex');
    const { insertedId: invitationId } = await testDb.db.collection('invitations').insertOne({
      salonId: salonD.tenantId, identifier, identifierType: 'email', name: 'Cross Tenant Manager', role: 'manager',
      locationIds: [salonD.locations[0].id], tokenHash: hashToken(rawToken),
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), status: 'pending',
      invitedBy: u1UserId, createdAt: new Date(), updatedAt: new Date(),
    });

    const previewRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${rawToken}`);
    expect(previewRes.status).toBe(200);
    expect(previewRes.body.data.userExists).toBe(true);

    const acceptRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${rawToken}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    expect(acceptRes.status).toBe(201);

    const usersWithIdentifier = await testDb.db.collection('users').find({ identifier }).toArray();
    expect(usersWithIdentifier).toHaveLength(1); // aucun nouveau User — réutilisé
    const userId = usersWithIdentifier[0]._id;

    const allMemberships = await testDb.db.collection('memberships').find({ userId }).toArray();
    expect(allMemberships).toHaveLength(2); // tenantA préexistant + tenantD nouveau
    const byTenant = new Map(allMemberships.map((m) => [m.tenantId, m.role]));
    expect(byTenant.get(tenantA)).toBe('stylist');
    expect(byTenant.get(salonD.tenantId)).toBe('manager');

    const invitationAfter = await testDb.db.collection('invitations').findOne({ _id: invitationId });
    expect(invitationAfter?.status).toBe('accepted');
  });

  it('ID-12: register avec salonSlug=beta → client créé dans le tenant beta (PAS un autre salon), Membership kind=client', async () => {
    const alpha = await seedSalon(testDb.db, { slug: 'idmt-id12-alpha' });
    const beta = await seedSalon(testDb.db, { slug: 'idmt-id12-beta' });
    const identifier = 'idmt-id12-beta-client@test.local';

    const res = await fetchJson(`${testApp.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Beta Client', identifier, phone: '+21620700001', password: 'RealPass123!', salonSlug: 'idmt-id12-beta' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data.user.salonId).toBe(beta.tenantId);

    const userDoc = await testDb.db.collection('users').findOne({ identifier });
    const clientInBeta = await testDb.db.collection('clients').findOne({ userId: userDoc!._id, salonId: beta.tenantId });
    expect(clientInBeta).toBeTruthy();
    const clientInAlpha = await testDb.db.collection('clients').findOne({ userId: userDoc!._id, salonId: alpha.tenantId });
    expect(clientInAlpha).toBeNull();
    const membership = await testDb.db.collection('memberships').findOne({ userId: userDoc!._id, tenantId: beta.tenantId });
    expect(membership?.kind).toBe('client');
  });

  it('ID-13: register avec un salonSlug inexistant → 404, aucun user créé', async () => {
    const identifier = 'idmt-id13-ghost@test.local';
    const res = await fetchJson(`${testApp.baseUrl}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Ghost', identifier, phone: '+21620700002', password: 'RealPass123!', salonSlug: 'idmt-id13-does-not-exist' }),
    });
    expect(res.status).toBe(404);
    const userDoc = await testDb.db.collection('users').findOne({ identifier });
    expect(userDoc).toBeNull();
  });

  it('ID-14: grant() owner multi-tenant → 2 memberships, nouveau profil staff créé, _id du staff d\'origine inchangé', async () => {
    const owner = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [locA1], defaultLocationId: locA1, name: 'ID-14 Grant Owner', identifier: 'idmt-id14-owner@test.local' });
    const staffSnapshot = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(owner.staffId) });

    const targetSalon = await seedSalon(testDb.db, { slug: 'idmt-id14-target' });
    const created = await memberships.grant('owner', {
      userId: owner.userId, tenantId: targetSalon.tenantId, role: 'owner',
      locationIds: [targetSalon.locations[0].id], defaultLocationId: targetSalon.locations[0].id,
    });

    const allMembershipsForOwner = await testDb.db.collection('memberships').find({ userId: new ObjectId(owner.userId) }).toArray();
    expect(allMembershipsForOwner).toHaveLength(2);

    const newStaff = await testDb.db.collection('staffs').findOne({ _id: created.staffId });
    expect(newStaff?.salonId).toBe(targetSalon.tenantId);
    expect(newStaff?._id.toString()).not.toBe(staffSnapshot?._id.toString()); // nouveau profil, jamais déplacé

    const staffAfter = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(owner.staffId) });
    expect(staffAfter?._id.toString()).toBe(staffSnapshot?._id.toString()); // _id d'origine inchangé
  });
});
