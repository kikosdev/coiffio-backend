/**
 * Sprint 2 v2 Prompt 5 — flux d'invitation. Réutilise `MembershipService.grant()`
 * (Prompt 3) pour la création profil staff + membership à l'acceptation — ces tests
 * vérifient le CONTRAT du flux (statuts, 410, 403, rollback, jamais de token en clair dans
 * une réponse), pas la logique de `grant()` elle-même (déjà couverte par
 * `membership-management.spec.ts`).
 *
 * Le token brut n'est JAMAIS renvoyé par l'API (par design — voir InvitationService) : les
 * tests qui exercent preview()/accept() se seedent donc leur PROPRE invitation directement
 * en base (driver natif), avec un token connu, plutôt que de tenter de l'extraire d'une
 * réponse HTTP réelle (impossible par construction — c'est justement ce qu'on vérifie).
 */
import { ObjectId } from 'mongodb';
import * as crypto from 'crypto';
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

const INVITATION_TTL_DAYS = 7;

function hashToken(rawToken: string): string {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
}

describe('invitations (Sprint 2 v2 Prompt 5)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantA: string;
  let locA: string;
  let owner: { staffId: string; userId: string };
  let ownerToken: string;

  beforeAll(async () => {
    testDb = await startTestDb('invitations');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'inv-tenant-a' });
    tenantA = salon.tenantId;
    locA = salon.locations[0].id;
    owner = await seedStaff(testDb.db, { tenantId: tenantA, role: 'owner', locationIds: [locA], defaultLocationId: locA, identifier: 'inv-owner@test.local' });
    ownerToken = signStaffJwt({ sub: owner.userId, salonId: tenantA, role: 'owner', staffId: owner.staffId });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function createInvitation(token: string, body: Record<string, unknown>) {
    return fetchJson(`${testApp.baseUrl}/invitations`, {
      method: 'POST',
      headers: { ...authHeader(token), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  /** Seed direct (driver natif) d'une invitation avec un token de test CONNU — même forme
   *  que `InvitationService.create()`, sans passer par l'API (le token clair n'en sort
   *  jamais, par design — voir le commentaire en tête de fichier). */
  async function seedInvitation(opts: {
    salonId: string; identifier: string; name: string; role: string; locationIds: string[];
    invitedBy: string; status?: string; expiresAt?: Date;
  }): Promise<{ id: string; rawToken: string }> {
    const rawToken = crypto.randomBytes(32).toString('hex');
    const doc = {
      salonId: opts.salonId,
      identifier: opts.identifier,
      identifierType: 'email' as const,
      name: opts.name,
      role: opts.role,
      locationIds: opts.locationIds,
      tokenHash: hashToken(rawToken),
      expiresAt: opts.expiresAt ?? new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000),
      status: opts.status ?? 'pending',
      invitedBy: new ObjectId(opts.invitedBy),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const { insertedId } = await testDb.db.collection('invitations').insertOne(doc);
    return { id: insertedId.toString(), rawToken };
  }

  it('POST /invitations ne renvoie jamais le token en clair (surface exacte de la réponse)', async () => {
    const res = await createInvitation(ownerToken, {
      identifier: 'inv-plain-check@test.local', name: 'Plain Response Check', role: 'stylist', locationIds: [locA],
    });
    expect(res.status).toBe(201);
    const data = res.body.data as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(['expiresAt', 'id', 'identifier', 'locationIds', 'name', 'role', 'status'].sort());
    expect(JSON.stringify(data)).not.toMatch(/token/i);

    // Relu depuis la base : tokenHash bien présent (select:false, donc invisible via l'API
    // normale) mais un hash SHA-256 (64 hex), jamais le token brut lui-même.
    const raw = await testDb.db.collection('invitations').findOne({ _id: new ObjectId(data.id as string) });
    expect(raw?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('manager invitant un owner → 403 (réutilise assertCanGrantRole de grant())', async () => {
    const manager = await seedStaff(testDb.db, { tenantId: tenantA, role: 'manager', locationIds: [locA], defaultLocationId: locA, identifier: 'inv-manager@test.local' });
    const managerToken = signStaffJwt({ sub: manager.userId, salonId: tenantA, role: 'manager', staffId: manager.staffId });

    const res = await createInvitation(managerToken, {
      identifier: 'inv-manager-tries-owner@test.local', name: 'Should Not Exist', role: 'owner', locationIds: [locA],
    });
    expect(res.status).toBe(403);

    const created = await testDb.db.collection('invitations').findOne({ identifier: 'inv-manager-tries-owner@test.local' });
    expect(created).toBeNull();
  });

  it('invitation dépassant staffMax (plan starter = 10) → 403 avec payload upsell LIMIT_REACHED', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'inv-staffmax' });
    const loc = salon.locations[0].id;
    const capOwner = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [loc], defaultLocationId: loc, identifier: 'inv-cap-owner@test.local' });
    for (let i = 0; i < 9; i++) {
      await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'stylist', locationIds: [loc], defaultLocationId: loc, identifier: `inv-cap-fill-${i}@test.local` });
    }
    const capToken = signStaffJwt({ sub: capOwner.userId, salonId: salon.tenantId, role: 'owner', staffId: capOwner.staffId });

    const res = await createInvitation(capToken, {
      identifier: 'inv-over-cap@test.local', name: 'Over Cap', role: 'stylist', locationIds: [loc],
    });
    expect(res.status).toBe(403);
    expect(res.body.data?.code).toBe('LIMIT_REACHED');
    expect(res.body.data?.limitKey).toBe('staffMax');
    expect(res.body.data?.current).toBe(10);
    expect(res.body.data?.limit).toBe(10);

    const created = await testDb.db.collection('invitations').findOne({ identifier: 'inv-over-cap@test.local' });
    expect(created).toBeNull();
  });

  it('GET /invitations liste, filtrable par status ; DELETE /invitations/:id révoque', async () => {
    const created = await createInvitation(ownerToken, {
      identifier: 'inv-revoke-me@test.local', name: 'Revoke Me', role: 'stylist', locationIds: [locA],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    const listRes = await fetchJson(`${testApp.baseUrl}/invitations?status=pending`, { headers: authHeader(ownerToken) });
    expect(listRes.status).toBe(200);
    expect((listRes.body.data as Array<{ id: string }>).some((i) => i.id === id)).toBe(true);

    const revokeRes = await fetchJson(`${testApp.baseUrl}/invitations/${id}`, { method: 'DELETE', headers: authHeader(ownerToken) });
    expect(revokeRes.status).toBe(200);
    expect(revokeRes.body.data.status).toBe('revoked');

    const revokedInDb = await testDb.db.collection('invitations').findOne({ _id: new ObjectId(id) });
    expect(revokedInDb?.status).toBe('revoked');
  });

  it('token inconnu → 404 sur GET /invitations/accept/:token', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/invitations/accept/not-a-real-token-at-all`);
    expect(res.status).toBe(404);
  });

  it("invitation expirée → 410, et le statut passe à 'expired' en base (expiration paresseuse)", async () => {
    const seeded = await seedInvitation({
      salonId: tenantA, identifier: 'inv-expired@test.local', name: 'Expired Person', role: 'stylist',
      locationIds: [locA], invitedBy: owner.userId, expiresAt: new Date(Date.now() - 1000),
    });
    const previewRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`);
    expect(previewRes.status).toBe(410);

    const inDb = await testDb.db.collection('invitations').findOne({ _id: new ObjectId(seeded.id) });
    expect(inDb?.status).toBe('expired');
  });

  it('invitation révoquée → 410 sur accept', async () => {
    const seeded = await seedInvitation({
      salonId: tenantA, identifier: 'inv-revoked-accept@test.local', name: 'Revoked Person', role: 'stylist',
      locationIds: [locA], invitedBy: owner.userId, status: 'revoked',
    });
    const res = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'RealPass123!' }),
    });
    expect(res.status).toBe(410);
  });

  describe('accept() — nouvel identifier', () => {
    it('preview → userExists:false ; accept sans password → 400 ; avec password → User+Staff+Membership créés, login effectif', async () => {
      const identifier = 'inv-new-person@test.local';
      const seeded = await seedInvitation({
        salonId: tenantA, identifier, name: 'Brand New Stylist', role: 'stylist', locationIds: [locA], invitedBy: owner.userId,
      });

      const previewRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`);
      expect(previewRes.status).toBe(200);
      expect(previewRes.body.data.userExists).toBe(false);
      expect(previewRes.body.data.role).toBe('stylist');
      expect(previewRes.body.data.identifier).toBe(identifier);

      const noPasswordRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(noPasswordRes.status).toBe(400);

      const acceptRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: 'BrandNewPass123!' }),
      });
      expect(acceptRes.status).toBe(201);
      expect(acceptRes.body.data.token).toBeTruthy();

      // Relu depuis la base — jamais l'objet retourné.
      const user = await testDb.db.collection('users').findOne({ identifier });
      expect(user).toBeTruthy();
      const staff = await testDb.db.collection('staffs').findOne({ userId: user!._id, salonId: tenantA });
      expect(staff).toBeTruthy();
      expect(staff?.name).toBe('Brand New Stylist');
      const membership = await testDb.db.collection('memberships').findOne({ userId: user!._id, tenantId: tenantA });
      expect(membership).toBeTruthy();
      expect(membership?.kind).toBe('staff');
      expect(membership?.role).toBe('stylist');
      const invitationAfter = await testDb.db.collection('invitations').findOne({ _id: new ObjectId(seeded.id) });
      expect(invitationAfter?.status).toBe('accepted');
      expect(invitationAfter?.acceptedAt).toBeTruthy();
      expect(invitationAfter?.membershipId?.toString()).toBe(membership!._id.toString());

      // Login réellement effectif avec les nouveaux identifiants.
      const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifier, password: 'BrandNewPass123!' }),
      });
      expect(loginRes.status).toBe(201);
    });
  });

  // Note (Prompt 7) : le cas cross-tenant ("accept sur un autre tenant réutilise le User,
  // crée un 2e Membership") est désormais ID-11 dans `identity-multitenant.spec.ts` — retiré
  // d'ici pour éviter la duplication.

  describe('accept() — rollback complet si une étape échoue', () => {
    it('un profil staff (userId,salonId) déjà présent sans Membership fait échouer grant() en transaction → rien ne persiste', async () => {
      const identifier = 'inv-rollback-target@test.local';
      const salonC = await seedSalon(testDb.db, { slug: 'inv-tenant-rollback' });
      const locC = salonC.locations[0].id;

      // User existant, staff profile planté directement dans le tenant cible SANS Membership
      // correspondant (état incohérent délibéré) — grant() passera findByUserAndTenant()
      // (aucun membership trouvé) puis heurtera l'index composite {userId,salonId} au moment
      // de créer le nouveau profil staff : même technique d'injection de panne que
      // `provisioning.spec.ts` (E11000), en pleine transaction cette fois.
      const existingUserId = new ObjectId();
      await testDb.db.collection('users').insertOne({
        _id: existingUserId, identifier, identifierType: 'email', passwordHash: bcrypt.hashSync('Whatever123!', 4), role: 'staff', isActive: true,
      });
      await testDb.db.collection('staffs').insertOne({
        _id: new ObjectId(), salonId: salonC.tenantId, userId: existingUserId, name: 'Planted Orphan Staff', email: '', phone: '',
        role: 'stylist', color: '#000', isActive: true, locationIds: [locC], defaultLocationId: locC,
        acceptingBookings: true, posEnabled: false, publicProfile: { visible: true, order: 0 },
      });

      const seeded = await seedInvitation({
        salonId: salonC.tenantId, identifier, name: 'Rollback Attempt', role: 'manager', locationIds: [locC], invitedBy: owner.userId,
      });

      const acceptRes = await fetchJson(`${testApp.baseUrl}/invitations/accept/${seeded.rawToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(acceptRes.status).toBeGreaterThanOrEqual(500); // E11000 non catché — remonte en erreur serveur, PAS un succès silencieux

      // Rien ne persiste : invitation toujours 'pending', pas de Membership créé, un SEUL
      // profil staff dans salonC pour ce user (le planté, inchangé — pas un 2e).
      const invitationAfter = await testDb.db.collection('invitations').findOne({ _id: new ObjectId(seeded.id) });
      expect(invitationAfter?.status).toBe('pending');
      const membershipAfter = await testDb.db.collection('memberships').findOne({ userId: existingUserId, tenantId: salonC.tenantId });
      expect(membershipAfter).toBeNull();
      const staffCountInC = await testDb.db.collection('staffs').countDocuments({ userId: existingUserId, salonId: salonC.tenantId });
      expect(staffCountInC).toBe(1); // toujours le seul planté, pas un doublon
    });
  });
});
