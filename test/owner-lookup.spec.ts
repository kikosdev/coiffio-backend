/**
 * [P2 owner multi-salon] `GET /internal/owners/lookup` — le lookup d'identité owner que le
 * Control Plane appellera AVANT de provisionner, pour proposer un rattachement plutôt que de
 * se prendre le 409 OWNER_EMAIL_TAKEN de P1 après coup.
 *
 * Trois issues à ne jamais confondre : pas de compte · compte mais owner nulle part · compte
 * owner. Plus la signature HMAC d'un GET SANS CORPS, qui est le piège réel de cette route
 * (leçon Sprint 3 P6 : le vrai guard signe `'{}'`, pas `''`) — prouvé ici contre le VRAI
 * `InternalAuthGuard`, jamais contre un mock.
 */
import { ObjectId } from 'mongodb';
import { MembershipService } from '../src/identity/membership.service';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  signInternal,
  seedSalon,
  seedStaff,
  seedClient,
  TestDb,
  TestApp,
  SeededTenant,
} from './utils/test-app';

describe('owner lookup (P2 owner multi-salon)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let memberships: MembershipService;

  let tenantA: SeededTenant; // "Joshef Coif" — salon d'origine de l'owner
  let tenantB: SeededTenant; // 2e salon du MÊME owner (rattaché via grant())
  let tenantC: SeededTenant; // tenant où le même user est CLIENT (ne doit jamais ressortir)
  const ownerEmail = 'joshef@p2-lookup.local';

  beforeAll(async () => {
    testDb = await startTestDb('owner-lookup');
    testApp = await bootApp();
    memberships = testApp.app.get(MembershipService);

    tenantA = await seedSalon(testDb.db, { slug: 'p2-joshef-a', name: 'Joshef Coif' });
    tenantB = await seedSalon(testDb.db, { slug: 'p2-joshef-b', name: 'Joshef Coif' }); // MÊME nom, exprès
    tenantC = await seedSalon(testDb.db, { slug: 'p2-joshef-c', name: 'Salon Tiers' });

    const owner = await seedStaff(testDb.db, {
      tenantId: tenantA.tenantId,
      role: 'owner',
      locationIds: [tenantA.locations[0].id],
      defaultLocationId: tenantA.locations[0].id,
      name: 'Joshef',
      identifier: ownerEmail,
    });

    // 2e membership owner — exactement le cas que ce chantier existe pour rendre visible.
    await memberships.grant('owner', {
      userId: owner.userId,
      tenantId: tenantB.tenantId,
      role: 'owner',
      locationIds: [tenantB.locations[0].id],
      defaultLocationId: tenantB.locations[0].id,
    });

    // Le MÊME user est aussi client d'un 3e salon : ce membership ne doit JAMAIS apparaître.
    await seedClient(testDb.db, { tenantId: tenantC.tenantId, phone: '+21620999111', userId: owner.userId });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  /** GET sans corps : on SIGNE `'{}'` (ce que le vrai guard recalcule) sans jamais l'ENVOYER
   *  (la spec fetch interdit un corps sur un GET). C'est le contrat exact du `dp-client`. */
  async function lookup(identifier: string, signedBody = '{}') {
    const { signature, timestamp } = signInternal(signedBody);
    const url = `${testApp.baseUrl}/internal/owners/lookup?identifier=${encodeURIComponent(identifier)}`;
    return fetchJson(url, { headers: { 'x-cp-signature': signature, 'x-cp-timestamp': timestamp } });
  }

  // ── Les trois issues ────────────────────────────────────────────────────────

  it('owner existant → exists:true + userId + un ownership par tenant possédé', async () => {
    const res = await lookup(ownerEmail);
    expect(res.status).toBe(200);

    const data = res.body.data as { exists: boolean; userId: string; ownerships: { tenantId: string; salonName: string }[] };
    expect(data.exists).toBe(true);
    expect(typeof data.userId).toBe('string');

    const byTenant = new Map(data.ownerships.map((o) => [o.tenantId, o.salonName]));
    expect(byTenant.size).toBe(2);
    expect(byTenant.get(tenantA.tenantId)).toBe('Joshef Coif');
    expect(byTenant.get(tenantB.tenantId)).toBe('Joshef Coif');

    // Le tenant où il est CLIENT n'est pas un "ownership" — moindre exposition.
    expect(byTenant.has(tenantC.tenantId)).toBe(false);
  });

  it('identifier inconnu → exists:false, sans userId ni ownerships', async () => {
    const res = await lookup('personne-connue@p2-lookup.local');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ exists: false });
  });

  it("compte existant mais owner nulle part → exists:true, ownerships:[] (3e cas UI 'account-not-owner')", async () => {
    const stylistEmail = 'stylist-only@p2-lookup.local';
    await seedStaff(testDb.db, {
      tenantId: tenantA.tenantId,
      role: 'stylist',
      locationIds: [tenantA.locations[0].id],
      defaultLocationId: tenantA.locations[0].id,
      identifier: stylistEmail,
    });

    const res = await lookup(stylistEmail);
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(true);
    expect(typeof res.body.data.userId).toBe('string');
    expect(res.body.data.ownerships).toEqual([]);
    // Distinct d'un inconnu : `exists` les sépare, c'est tout l'intérêt des 3 états.
    expect(res.body.data.exists).not.toBe(false);
  });

  // ── Le guard : prouver ce qu'il BLOQUE ──────────────────────────────────────

  it('aucun en-tête de signature → 401 (le guard bloque avant le contrôleur)', async () => {
    const url = `${testApp.baseUrl}/internal/owners/lookup?identifier=${encodeURIComponent(ownerEmail)}`;
    const res = await fetchJson(url);
    expect(res.status).toBe(401);
    expect(res.body?.data?.exists).toBeUndefined(); // rien du tout n'a fuité
  });

  it('signature invalide → 401', async () => {
    const url = `${testApp.baseUrl}/internal/owners/lookup?identifier=${encodeURIComponent(ownerEmail)}`;
    const res = await fetchJson(url, {
      headers: { 'x-cp-signature': 'deadbeef'.repeat(8), 'x-cp-timestamp': String(Date.now()) },
    });
    expect(res.status).toBe(401);
  });

  it('timestamp hors fenêtre anti-rejeu → 401', async () => {
    const { signature, timestamp } = signInternal('{}', Date.now() - 120_001);
    const url = `${testApp.baseUrl}/internal/owners/lookup?identifier=${encodeURIComponent(ownerEmail)}`;
    const res = await fetchJson(url, { headers: { 'x-cp-signature': signature, 'x-cp-timestamp': timestamp } });
    expect(res.status).toBe(401);
  });

  it("corps HMAC d'un GET : signer '' échoue, signer '{}' passe (le vrai guard recalcule '{}')", async () => {
    // LE piège de cette route. Un appelant qui signe la chaîne vide — l'intuition naturelle
    // pour un GET sans corps — est rejeté par le VRAI guard : `req.rawBody` est `undefined`
    // (le body-parser d'Express ne tourne pas sans corps), donc il retombe sur
    // `JSON.stringify(req.body ?? {})`, soit littéralement `'{}'`.
    const wrong = await lookup(ownerEmail, '');
    expect(wrong.status).toBe(401);

    const right = await lookup(ownerEmail, '{}');
    expect(right.status).toBe(200);
    expect(right.body.data.exists).toBe(true);
  });

  // ── Normalisation ───────────────────────────────────────────────────────────

  it("l'identifier est normalisé serveur : casse email et formats de téléphone", async () => {
    const upper = await lookup(ownerEmail.toUpperCase());
    expect(upper.status).toBe(200);
    expect(upper.body.data.exists).toBe(true);
    expect(upper.body.data.ownerships).toHaveLength(2);

    // Un owner dont l'identifier est un téléphone canonique : retrouvé depuis un format brut.
    const phoneTenant = await seedSalon(testDb.db, { slug: 'p2-phone-owner', name: 'Salon Phone' });
    await seedStaff(testDb.db, {
      tenantId: phoneTenant.tenantId,
      role: 'owner',
      locationIds: [phoneTenant.locations[0].id],
      defaultLocationId: phoneTenant.locations[0].id,
      identifier: '+21620555444',
    });

    for (const raw of ['+21620555444', '20 555 444', '0021620555444']) {
      const res = await lookup(raw);
      expect(res.status).toBe(200);
      expect(res.body.data.exists).toBe(true);
      expect(res.body.data.ownerships).toEqual([
        expect.objectContaining({ tenantId: phoneTenant.tenantId, salonName: 'Salon Phone' }),
      ]);
    }
  });

  // ── Moindre exposition ──────────────────────────────────────────────────────

  it('la réponse ne porte QUE le contrat annoncé — aucun secret, aucun contact, aucun staffId', async () => {
    const res = await lookup(ownerEmail);
    expect(Object.keys(res.body.data).sort()).toEqual(['exists', 'ownerships', 'userId']);
    for (const o of res.body.data.ownerships as Record<string, unknown>[]) {
      // [P4] `locationLabel` fait maintenant partie du contrat, mais reste OPTIONNEL : les
      // salons de cette fixture n'en ont pas, donc la clé est absente — jamais fabriquée en
      // chaîne vide. Le cas "présent" est couvert par le test dédié ci-dessous.
      expect(Object.keys(o).sort()).toEqual(['salonName', 'tenantId']);
    }

    const raw = JSON.stringify(res.body);
    for (const leak of ['passwordHash', 'staffId', 'clientId', 'identifier', ownerEmail]) {
      expect(raw).not.toContain(leak);
    }
  });

  it('[P4] locationLabel remonté quand il existe — deux salons homonymes deviennent distinguables', async () => {
    // C'est LE cas d'usage du champ : deux tenants "Joshef Coif", que seul le libellé
    // d'emplacement sépare à l'écran côté Control Plane.
    await testDb.db.collection('salons').updateOne({ _id: new ObjectId(tenantA.tenantId) }, { $set: { locationLabel: 'Ezzahra' } });
    await testDb.db.collection('salons').updateOne({ _id: new ObjectId(tenantB.tenantId) }, { $set: { locationLabel: 'Menzah 6' } });

    const res = await lookup(ownerEmail);
    expect(res.status).toBe(200);

    const byTenant = new Map((res.body.data.ownerships as { tenantId: string; salonName: string; locationLabel?: string }[]).map((o) => [o.tenantId, o]));
    expect(byTenant.get(tenantA.tenantId)).toEqual({ tenantId: tenantA.tenantId, salonName: 'Joshef Coif', locationLabel: 'Ezzahra' });
    expect(byTenant.get(tenantB.tenantId)).toEqual({ tenantId: tenantB.tenantId, salonName: 'Joshef Coif', locationLabel: 'Menzah 6' });

    // Même nom, libellés différents : c'est bien le libellé qui porte la distinction.
    expect(byTenant.get(tenantA.tenantId)!.salonName).toBe(byTenant.get(tenantB.tenantId)!.salonName);
    expect(byTenant.get(tenantA.tenantId)!.locationLabel).not.toBe(byTenant.get(tenantB.tenantId)!.locationLabel);

    // Remis à l'état initial : les autres tests de ce fichier assertent l'absence du champ.
    await testDb.db.collection('salons').updateMany(
      { _id: { $in: [new ObjectId(tenantA.tenantId), new ObjectId(tenantB.tenantId)] } },
      { $unset: { locationLabel: '' } },
    );
  });

  // ── Statut du membership ────────────────────────────────────────────────────

  it('un accès owner RÉVOQUÉ ne compte plus comme un ownership', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'p2-revoked', name: 'Salon Revoked' });
    const loc = salon.locations[0].id;
    // Deux owners : sans ça, révoquer le seul owner échoue en 409 LAST_OWNER (Sprint 2 P3).
    await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [loc], defaultLocationId: loc, identifier: 'p2-owner-keep@p2-lookup.local' });
    const leaving = await seedStaff(testDb.db, { tenantId: salon.tenantId, role: 'owner', locationIds: [loc], defaultLocationId: loc, identifier: 'p2-owner-leave@p2-lookup.local' });

    const before = await lookup('p2-owner-leave@p2-lookup.local');
    expect(before.body.data.ownerships).toHaveLength(1);

    const membership = await testDb.db.collection('memberships').findOne({ userId: new ObjectId(leaving.userId), tenantId: salon.tenantId });
    await memberships.revoke(membership!._id.toString());

    const after = await lookup('p2-owner-leave@p2-lookup.local');
    expect(after.body.data.exists).toBe(true); // le compte existe toujours
    expect(after.body.data.ownerships).toEqual([]); // mais il ne pilote plus rien
  });

  // ── Validation d'entrée ─────────────────────────────────────────────────────

  it('identifier manquant → 400 (ValidationPipe), pas un 500 ni un exists:false trompeur', async () => {
    const { signature, timestamp } = signInternal('{}');
    const res = await fetchJson(`${testApp.baseUrl}/internal/owners/lookup`, {
      headers: { 'x-cp-signature': signature, 'x-cp-timestamp': timestamp },
    });
    expect(res.status).toBe(400);
  });
});
