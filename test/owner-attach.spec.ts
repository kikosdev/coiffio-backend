/**
 * [P3 owner multi-salon] Rattachement EXPLICITE d'un nouveau tenant à un compte owner
 * existant (décision 8). Deux branches nettes dans `provisionTenant` :
 *   - sans flag  → chemin historique (création du compte) + 409 si l'email est déjà pris (P1)
 *   - avec flag  → `grant()` réutilise le compte, crée le profil staff du nouveau tenant
 *
 * Ce que ce fichier prouve en priorité : qu'aucun rattachement ne peut arriver SILENCIEUSEMENT
 * (ni par email connu, ni par ownerUserId dépareillé), et que la branche création n'a pas
 * bougé d'un pouce.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  internalHeaders,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('owner attach (P3 owner multi-salon)', () => {
  let testDb: TestDb;
  let testApp: TestApp;

  beforeAll(async () => {
    testDb = await startTestDb('owner-attach');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  async function provision(payload: Record<string, unknown>) {
    const bodyStr = JSON.stringify(payload);
    return fetchJson(`${testApp.baseUrl}/internal/tenants`, { method: 'POST', headers: internalHeaders(bodyStr), body: bodyStr });
  }

  function dto(over: Record<string, unknown> = {}) {
    const n = new ObjectId().toString();
    return {
      tenantId: n,
      slug: `attach-${n.slice(-8)}`,
      name: 'Joshef Coif',
      owner: { name: 'Joshef', email: `joshef-${n.slice(-8)}@attach.test`, phone: '+21620000801', password: 'password123' },
      ...over,
    };
  }

  /** Crée un owner réel via le chemin nominal et renvoie de quoi le rattacher ailleurs. */
  async function seedRealOwner() {
    const first = dto();
    const res = await provision(first);
    expect([200, 201]).toContain(res.status);
    return {
      email: (first.owner as { email: string }).email,
      userId: res.body.data.ownerUserId as string,
      staffId: res.body.data.ownerStaffId as string,
      tenantId: first.tenantId,
    };
  }

  // ── Branche création : non-régression stricte ───────────────────────────────

  it('nouvel owner (sans flag) → compte créé, membership owner, schedule sur le staff créé', async () => {
    const payload = dto();
    const res = await provision(payload);
    expect([200, 201]).toContain(res.status);

    const { tenantId, ownerStaffId, ownerUserId, locationId } = res.body.data;
    expect(typeof ownerUserId).toBe('string'); // nouveau champ du contrat

    const [user, staff, membership, schedule] = await Promise.all([
      testDb.db.collection('users').findOne({ _id: new ObjectId(ownerUserId as string) }),
      testDb.db.collection('staffs').findOne({ _id: new ObjectId(ownerStaffId as string) }),
      testDb.db.collection('memberships').findOne({ userId: new ObjectId(ownerUserId as string), tenantId }),
      testDb.db.collection('schedules').findOne({ salonId: tenantId }),
    ]);

    expect(user?.role).toBe('owner');
    expect(staff?.salonId).toBe(tenantId);
    expect(membership?.role).toBe('owner');
    expect(membership?.status).toBe('active');
    // Le schedule référence bien le profil staff owner (et pas un id fantôme).
    expect(schedule?.stylistId?.toString()).toBe(ownerStaffId);
    expect(schedule?.locationId).toBe(locationId);
  });

  // ── Le refus par défaut (décision 8) ───────────────────────────────────────

  it('email déjà pris SANS flag → 409 OWNER_EMAIL_TAKEN, aucun rattachement silencieux', async () => {
    const owner = await seedRealOwner();

    const res = await provision(dto({ owner: { name: 'Joshef', email: owner.email, phone: '+21620000802', password: 'password123' } }));
    expect(res.status).toBe(409);
    expect(res.body.data?.code).toBe('OWNER_EMAIL_TAKEN');

    // Un seul membership : rien n'a été rattaché en douce.
    const count = await testDb.db.collection('memberships').countDocuments({ userId: new ObjectId(owner.userId) });
    expect(count).toBe(1);
  });

  it('ownerUserId SANS le flag → 400 (intention ambiguë refusée, jamais devinée)', async () => {
    const owner = await seedRealOwner();
    const res = await provision(dto({ ownerUserId: owner.userId, owner: { name: 'Joshef', email: owner.email, phone: '+216', password: 'password123' } }));
    expect(res.status).toBe(400);
    expect(res.body.data?.code).toBe('ATTACH_FLAG_REQUIRED');
  });

  it('flag SANS ownerUserId → 400 (ValidationPipe, dépendance conditionnelle)', async () => {
    const res = await provision(dto({ attachToExistingOwner: true }));
    expect(res.status).toBe(400);
  });

  it('ownerUserId inconnu → 404 OWNER_NOT_FOUND, rien n\'est créé', async () => {
    const payload = dto({ attachToExistingOwner: true, ownerUserId: new ObjectId().toString() });
    const res = await provision(payload);
    expect(res.status).toBe(404);
    expect(res.body.data?.code).toBe('OWNER_NOT_FOUND');
    expect(await testDb.db.collection('salons').countDocuments({ _id: new ObjectId(payload.tenantId as string) })).toBe(0);
  });

  it('ownerUserId qui ne correspond PAS à owner.email → 400 OWNER_IDENTIFIER_MISMATCH', async () => {
    const a = await seedRealOwner();
    const b = await seedRealOwner();

    // Le flag est explicite, mais l'identité désignée diverge de l'email annoncé : c'est le
    // scénario "mauvais owner" que la décision 8 existe pour empêcher, déplacé d'un champ.
    const payload = dto({
      attachToExistingOwner: true,
      ownerUserId: a.userId,
      owner: { name: 'Joshef', email: b.email, phone: '+21620000803' },
    });
    const res = await provision(payload);
    expect(res.status).toBe(400);
    expect(res.body.data?.code).toBe('OWNER_IDENTIFIER_MISMATCH');
    expect(await testDb.db.collection('salons').countDocuments({ _id: new ObjectId(payload.tenantId as string) })).toBe(0);
  });

  it('compte désactivé → 409 OWNER_INACTIVE', async () => {
    const owner = await seedRealOwner();
    await testDb.db.collection('users').updateOne({ _id: new ObjectId(owner.userId) }, { $set: { isActive: false } });

    const res = await provision(dto({ attachToExistingOwner: true, ownerUserId: owner.userId, owner: { name: 'Joshef', email: owner.email, phone: '+216' } }));
    expect(res.status).toBe(409);
    expect(res.body.data?.code).toBe('OWNER_INACTIVE');
  });

  // ── LE cas nominal du chantier ─────────────────────────────────────────────

  it('rattachement explicite → pas de nouveau compte, 2e membership owner, 2e profil staff, contacts du DTO', async () => {
    const owner = await seedRealOwner();
    const usersBefore = await testDb.db.collection('users').countDocuments({});

    // Téléphone et nom DIFFÉRENTS du 1er salon : si grant() recopiait le profil le plus
    // ancien au lieu des overrides, ce test tomberait — c'est précisément son objet.
    const payload = dto({
      name: 'Joshef Coif',
      attachToExistingOwner: true,
      ownerUserId: owner.userId,
      owner: { name: 'Joshef Menzah', email: owner.email, phone: '+21699887766' },
    });
    const res = await provision(payload);
    expect([200, 201]).toContain(res.status);

    const { tenantId, ownerStaffId, ownerUserId, locationId } = res.body.data;
    expect(ownerUserId).toBe(owner.userId); // le MÊME compte, réutilisé
    expect(ownerStaffId).not.toBe(owner.staffId); // mais un profil staff NEUF

    // 1 seul users : aucun compte n'a été créé.
    expect(await testDb.db.collection('users').countDocuments({})).toBe(usersBefore);

    // 2 memberships owner, un par tenant.
    const memberships = await testDb.db.collection('memberships').find({ userId: new ObjectId(owner.userId) }).toArray();
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.role === 'owner' && m.status === 'active')).toBe(true);
    expect(new Set(memberships.map((m) => m.tenantId))).toEqual(new Set([owner.tenantId, tenantId]));

    // 2 profils staff, et celui d'origine est INTACT.
    const staffs = await testDb.db.collection('staffs').find({ userId: new ObjectId(owner.userId) }).sort({ createdAt: 1 }).toArray();
    expect(staffs).toHaveLength(2);
    expect(staffs[0]._id.toString()).toBe(owner.staffId);
    expect(staffs[0].phone).toBe('+21620000801'); // le 1er salon n'a pas bougé

    // Le nouveau profil porte les valeurs du DTO, PAS celles recopiées de l'ancien.
    const fresh = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(ownerStaffId as string) });
    expect(fresh?.name).toBe('Joshef Menzah');
    expect(fresh?.phone).toBe('+21699887766');
    expect(fresh?.salonId).toBe(tenantId);
    expect(fresh?.locationIds).toEqual([locationId]);

    // Le schedule référence le staff créé par grant(), pas un id de l'autre tenant.
    const schedule = await testDb.db.collection('schedules').findOne({ salonId: tenantId });
    expect(schedule?.stylistId?.toString()).toBe(ownerStaffId);

    // Le tenant est complet : location primaire + 4 services par défaut.
    expect(await testDb.db.collection('locations').countDocuments({ salonId: tenantId, isPrimary: true })).toBe(1);
    expect(await testDb.db.collection('services').countDocuments({ salonId: tenantId })).toBe(4);
  });

  it('[P4] locationLabel persisté sur les DEUX branches (création et rattachement)', async () => {
    // Le salon est créé AVANT la bifurcation, donc un seul point d'écriture couvre les deux
    // branches — ce test verrouille ce fait plutôt que de le supposer.
    const owner = await seedRealOwner();

    const created = await provision(dto({ locationLabel: 'Ezzahra' }));
    expect([200, 201]).toContain(created.status);
    const salonA = await testDb.db.collection('salons').findOne({ _id: new ObjectId(created.body.data.tenantId as string) });
    expect(salonA?.locationLabel).toBe('Ezzahra');

    const attached = await provision(dto({
      locationLabel: 'Menzah 6',
      attachToExistingOwner: true,
      ownerUserId: owner.userId,
      owner: { name: 'Joshef', email: owner.email, phone: '+21620000804' },
    }));
    expect([200, 201]).toContain(attached.status);
    const salonB = await testDb.db.collection('salons').findOne({ _id: new ObjectId(attached.body.data.tenantId as string) });
    expect(salonB?.locationLabel).toBe('Menzah 6');
  });

  it('[P4] locationLabel absent → champ absent du document, jamais une chaîne vide', async () => {
    const res = await provision(dto());
    expect([200, 201]).toContain(res.status);
    const salon = await testDb.db.collection('salons').findOne({ _id: new ObjectId(res.body.data.tenantId as string) });
    expect(salon).not.toHaveProperty('locationLabel');
  });

  it("users.role du compte réutilisé reste FIGÉ (bucket ; Membership.role fait autorité)", async () => {
    // Un compte identifié comme 'staff' au global : le rattacher comme owner d'un nouveau
    // salon ne doit PAS réécrire users.role — l'autorité est Membership.role.
    const owner = await seedRealOwner();
    await testDb.db.collection('users').updateOne({ _id: new ObjectId(owner.userId) }, { $set: { role: 'staff' } });

    const res = await provision(dto({ attachToExistingOwner: true, ownerUserId: owner.userId, owner: { name: 'Joshef', email: owner.email, phone: '+216' } }));
    expect([200, 201]).toContain(res.status);

    const user = await testDb.db.collection('users').findOne({ _id: new ObjectId(owner.userId) });
    expect(user?.role).toBe('staff'); // inchangé, volontairement
    const membership = await testDb.db.collection('memberships').findOne({ userId: new ObjectId(owner.userId), tenantId: res.body.data.tenantId });
    expect(membership?.role).toBe('owner'); // l'autorité réelle
  });

  it('rejouer le même tenantId rattaché → idempotent (mêmes ids, aucun doublon)', async () => {
    const owner = await seedRealOwner();
    const payload = dto({ attachToExistingOwner: true, ownerUserId: owner.userId, owner: { name: 'Joshef', email: owner.email, phone: '+216' } });

    const first = await provision(payload);
    expect([200, 201]).toContain(first.status);
    const second = await provision(payload);
    expect([200, 201]).toContain(second.status);

    expect(second.body.data.ownerStaffId).toBe(first.body.data.ownerStaffId);
    expect(second.body.data.ownerUserId).toBe(first.body.data.ownerUserId);
    expect(await testDb.db.collection('memberships').countDocuments({ userId: new ObjectId(owner.userId) })).toBe(2);
    expect(await testDb.db.collection('staffs').countDocuments({ salonId: payload.tenantId as string })).toBe(1);
  });

  it("membership déjà présent sur un tenant non encore provisionné → 409 propre de grant(), pas un 500, rollback complet", async () => {
    // État résiduel possible (membership orphelin) : le 409 de `grant()` doit remonter tel
    // quel à travers le catch de P1, qui ne convertit QUE les collisions d'identifier.
    const owner = await seedRealOwner();
    const payload = dto({ attachToExistingOwner: true, ownerUserId: owner.userId, owner: { name: 'Joshef', email: owner.email, phone: '+216' } });

    await testDb.db.collection('memberships').insertOne({
      userId: new ObjectId(owner.userId),
      tenantId: payload.tenantId as string,
      kind: 'staff',
      staffId: new ObjectId(owner.staffId),
      role: 'owner',
      locationIds: [],
      status: 'active',
    });

    const res = await provision(payload);
    expect(res.status).toBe(409);
    expect(res.body.data?.code).not.toBe('OWNER_EMAIL_TAKEN'); // pas le 409 de P1, celui de grant()
    expect(await testDb.db.collection('salons').countDocuments({ _id: new ObjectId(payload.tenantId as string) })).toBe(0);
    expect(await testDb.db.collection('staffs').countDocuments({ salonId: payload.tenantId as string })).toBe(0);
  });
});
