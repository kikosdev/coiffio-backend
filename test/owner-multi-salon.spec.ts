/**
 * [P-CONSO] Suite de clôture du chantier "owner multi-salon" — le scénario Joshef Coif joué
 * de bout en bout, dans l'ordre, sur une seule fixture partagée. Chaque `it` est une étape
 * du récit, pas un cas isolé : c'est ce qui la distingue de `owner-attach.spec.ts` (P3, les
 * garde-fous branche par branche) et de `owner-lookup.spec.ts` (P2, le contrat du lookup).
 *
 * Elle couvre en propre deux choses qu'aucune autre suite ne prouve :
 *   - l'email de bienvenue : ENVOYÉ sur la branche création, JAMAIS sur le rattachement ;
 *   - l'ISOLATION des données entre les deux salons du MÊME propriétaire, avec une vraie
 *     session (login réel + X-Tenant-Id), qui est l'exigence de fond du chantier.
 */
import { ObjectId } from 'mongodb';
import * as bcrypt from 'bcryptjs';
import { EmailService } from '../src/email/email.service';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  internalHeaders,
  signInternal,
  authHeader,
  TestDb,
  TestApp,
} from './utils/test-app';

const OWNER_EMAIL = 'joshef@conso.local';
const OWNER_PASSWORD = 'JoshefPass123!';

describe('owner multi-salon — scénario Joshef Coif de bout en bout (P-CONSO)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let sendEmailSpy: jest.SpyInstance;

  const tenantEzzahra = new ObjectId().toString();
  const tenantMenzah = new ObjectId().toString();
  let ownerUserId = '';
  let staffEzzahraId = '';
  let staffMenzahId = '';

  beforeAll(async () => {
    testDb = await startTestDb('owner-multi-salon');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  beforeEach(() => {
    // `sendEmail` est déjà un no-op réseau sous NODE_ENV=test (docstring d'EmailService) —
    // on l'espionne ici pour vérifier CE QUI serait envoyé, jamais pour l'empêcher.
    sendEmailSpy = jest.spyOn(EmailService.prototype, 'sendEmail').mockResolvedValue(undefined);
  });
  afterEach(() => sendEmailSpy.mockRestore());

  async function provision(payload: Record<string, unknown>) {
    const bodyStr = JSON.stringify(payload);
    return fetchJson(`${testApp.baseUrl}/internal/tenants`, { method: 'POST', headers: internalHeaders(bodyStr), body: bodyStr });
  }
  async function lookup(identifier: string) {
    const { signature, timestamp } = signInternal('{}');
    return fetchJson(`${testApp.baseUrl}/internal/owners/lookup?identifier=${encodeURIComponent(identifier)}`, {
      headers: { 'x-cp-signature': signature, 'x-cp-timestamp': timestamp },
    });
  }
  async function login(): Promise<string> {
    const res = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: OWNER_EMAIL, password: OWNER_PASSWORD }),
    });
    expect(res.status).toBe(201);
    return res.body.data.token as string;
  }

  // ── Étape 1 : le premier salon, owner tout neuf ────────────────────────────

  it('MS-01: salon 1 (Ezzahra) avec un email owner NEUF → compte créé, email de bienvenue envoyé', async () => {
    const res = await provision({
      tenantId: tenantEzzahra,
      slug: 'joshef-ezzahra',
      name: 'Joshef Coif',
      locationLabel: 'Ezzahra',
      owner: { name: 'Joshef', email: OWNER_EMAIL, phone: '+21620001201' },
    });
    expect([200, 201]).toContain(res.status);

    ownerUserId = res.body.data.ownerUserId;
    staffEzzahraId = res.body.data.ownerStaffId;
    expect(ownerUserId).toMatch(/^[0-9a-f]{24}$/);

    // Aucun mot de passe fourni par l'appelant ⇒ le compte n'est utilisable que via le lien
    // de définition de mot de passe envoyé ici. C'est LA raison d'être de cet email.
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    expect(sendEmailSpy.mock.calls[0][0]).toMatchObject({ to: OWNER_EMAIL });
    expect(sendEmailSpy.mock.calls[0][0].subject).toContain('Bienvenue');

    const salon = await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantEzzahra) });
    expect(salon).toMatchObject({ name: 'Joshef Coif', slug: 'joshef-ezzahra', locationLabel: 'Ezzahra' });
  });

  // ── Étape 2 : le refus par défaut, puis le rattachement explicite ──────────

  it("MS-02: le MÊME email sans flag → 409 OWNER_EMAIL_TAKEN, et aucun email n'est envoyé", async () => {
    const res = await provision({
      tenantId: new ObjectId().toString(),
      slug: 'joshef-refuse',
      name: 'Joshef Coif',
      owner: { name: 'Joshef', email: OWNER_EMAIL, phone: '+21620001202' },
    });
    expect(res.status).toBe(409);
    expect(res.body.data?.code).toBe('OWNER_EMAIL_TAKEN');
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('MS-03: le lookup identifie Joshef comme owner du salon 1, avec son locationLabel', async () => {
    const res = await lookup(OWNER_EMAIL);
    expect(res.status).toBe(200);
    expect(res.body.data.exists).toBe(true);
    expect(res.body.data.userId).toBe(ownerUserId);
    expect(res.body.data.ownerships).toEqual([
      { tenantId: tenantEzzahra, salonName: 'Joshef Coif', locationLabel: 'Ezzahra' },
    ]);
  });

  it('MS-04: salon 2 (Menzah 6) rattaché explicitement → aucun nouveau compte, AUCUN email', async () => {
    const res = await provision({
      tenantId: tenantMenzah,
      slug: 'joshef-menzah-6',
      name: 'Joshef Coif', // MÊME nom, exprès
      locationLabel: 'Menzah 6',
      attachToExistingOwner: true,
      ownerUserId,
      owner: { name: 'Joshef Menzah 6', email: OWNER_EMAIL, phone: '+21699887766' },
    });
    expect([200, 201]).toContain(res.status);
    staffMenzahId = res.body.data.ownerStaffId;

    expect(res.body.data.ownerUserId).toBe(ownerUserId); // le MÊME compte
    expect(staffMenzahId).not.toBe(staffEzzahraId); // un profil staff NEUF

    // Le compte existe déjà et a son mot de passe : lui envoyer un lien de définition de mot
    // de passe serait au mieux troublant, au pire un reset non sollicité déclenché depuis le CP.
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  // ── Étape 3 : l'état exact en base ─────────────────────────────────────────

  it('MS-05: état en base — 1 user, 2 memberships owner, 2 profils staff, 2 salons homonymes', async () => {
    const users = await testDb.db.collection('users').countDocuments({ identifier: OWNER_EMAIL });
    expect(users).toBe(1);

    const memberships = await testDb.db.collection('memberships').find({ userId: new ObjectId(ownerUserId) }).toArray();
    expect(memberships).toHaveLength(2);
    expect(memberships.every((m) => m.role === 'owner' && m.status === 'active')).toBe(true);
    expect(new Set(memberships.map((m) => m.tenantId))).toEqual(new Set([tenantEzzahra, tenantMenzah]));

    const staffs = await testDb.db.collection('staffs').find({ userId: new ObjectId(ownerUserId) }).sort({ createdAt: 1 }).toArray();
    expect(staffs).toHaveLength(2);
    expect(staffs[0]._id.toString()).toBe(staffEzzahraId); // le profil d'origine n'a pas bougé
    expect(staffs[0].phone).toBe('+21620001201'); // ni ses coordonnées
    expect(staffs[1].phone).toBe('+21699887766'); // le nouveau porte celles du DTO

    const salons = await testDb.db.collection('salons').find({ _id: { $in: [new ObjectId(tenantEzzahra), new ObjectId(tenantMenzah)] } }).toArray();
    expect(salons).toHaveLength(2);
    expect(new Set(salons.map((s) => s.name))).toEqual(new Set(['Joshef Coif'])); // MÊME nom
    expect(new Set(salons.map((s) => s.locationLabel))).toEqual(new Set(['Ezzahra', 'Menzah 6'])); // seuls les libellés diffèrent
    expect(new Set(salons.map((s) => s.slug)).size).toBe(2);
  });

  it('MS-06: le lookup voit désormais les DEUX salons, distinguables par leur seul libellé', async () => {
    const res = await lookup(OWNER_EMAIL);
    const owns = res.body.data.ownerships as { tenantId: string; salonName: string; locationLabel?: string }[];
    expect(owns).toHaveLength(2);
    expect(new Set(owns.map((o) => o.salonName))).toEqual(new Set(['Joshef Coif']));
    expect(new Set(owns.map((o) => o.locationLabel))).toEqual(new Set(['Ezzahra', 'Menzah 6']));
  });

  // ── Étape 4 : L'ISOLATION — l'exigence de fond du chantier ────────────────

  it('MS-07: une vraie session résout les 2 tenants, avec le rôle owner sur CHACUN', async () => {
    // Le provisioning n'expose aucun mot de passe (aléatoire, jamais renvoyé) : on en pose un
    // connu pour pouvoir ouvrir une VRAIE session. C'est la seule manipulation de fixture de
    // ce scénario, et elle ne touche que `passwordHash`.
    await testDb.db.collection('users').updateOne(
      { _id: new ObjectId(ownerUserId) },
      { $set: { passwordHash: bcrypt.hashSync(OWNER_PASSWORD, 4) } },
    );

    const token = await login();

    // 2 memberships ⇒ le tenant actif doit être désigné EXPLICITEMENT, sur TOUTE route sans
    // exception — `TenantContextMiddleware` résout avant qu'aucun contrôleur ne s'exécute, y
    // compris pour `/auth/me/memberships`, pourtant destiné au futur sélecteur de salon.
    // Ce n'est pas un blocage : la réponse 400 PORTE elle-même la liste des memberships,
    // c'est par là qu'un sélecteur s'amorce au tout premier chargement (contrainte à
    // connaître pour le chantier switcher, hors périmètre ici).
    const ambiguous = await fetchJson(`${testApp.baseUrl}/auth/me/memberships`, { headers: authHeader(token) });
    expect(ambiguous.status).toBe(400);
    const bootstrapList = (ambiguous.body.data?.memberships ?? []) as { tenantId: string }[];
    expect(new Set(bootstrapList.map((m) => m.tenantId))).toEqual(new Set([tenantEzzahra, tenantMenzah]));

    // Avec un tenant actif désigné, la liste complète est servie normalement.
    const list = await fetchJson(`${testApp.baseUrl}/auth/me/memberships`, {
      headers: { ...authHeader(token), 'x-tenant-id': tenantEzzahra },
    });
    expect(list.status).toBe(200);
    const byTenant = new Map((list.body.data as { tenantId: string; role: string; tenantName: string }[]).map((m) => [m.tenantId, m]));
    expect(byTenant.get(tenantEzzahra)?.role).toBe('owner');
    expect(byTenant.get(tenantMenzah)?.role).toBe('owner');
    // Owner des deux : le rôle vient du membership actif, pas d'un champ global du compte.
    expect(byTenant.get(tenantEzzahra)?.tenantName).toBe('Joshef Coif');
    expect(byTenant.get(tenantMenzah)?.tenantName).toBe('Joshef Coif');
  });

  it("MS-08: ISOLATION — une donnée créée dans Ezzahra n'apparaît JAMAIS dans Menzah 6", async () => {
    const token = await login();
    const asEzzahra = { ...authHeader(token), 'x-tenant-id': tenantEzzahra, 'Content-Type': 'application/json' };
    const asMenzah = { ...authHeader(token), 'x-tenant-id': tenantMenzah, 'Content-Type': 'application/json' };

    // Chaque salon démarre avec SON propre catalogue par défaut (4 services), aucun partagé.
    const before = await Promise.all([
      fetchJson(`${testApp.baseUrl}/services`, { headers: asEzzahra }),
      fetchJson(`${testApp.baseUrl}/services`, { headers: asMenzah }),
    ]);
    expect(before[0].status).toBe(200);
    expect(before[1].status).toBe(200);
    const idsEzzahra = (before[0].body.data as { _id: string }[]).map((s) => s._id);
    const idsMenzah = (before[1].body.data as { _id: string }[]).map((s) => s._id);
    expect(idsEzzahra).toHaveLength(4);
    expect(idsMenzah).toHaveLength(4);
    expect(idsEzzahra.filter((id) => idsMenzah.includes(id))).toEqual([]); // zéro service partagé

    // Une création scopée sur Ezzahra…
    const created = await fetchJson(`${testApp.baseUrl}/services`, {
      method: 'POST',
      headers: asEzzahra,
      body: JSON.stringify({ name: 'Coupe Signature Ezzahra', category: 'Cheveux', gender: 'universal', price: 120, durationMin: 60 }),
    });
    expect([200, 201]).toContain(created.status);

    // …est visible dans Ezzahra…
    const afterEzzahra = await fetchJson(`${testApp.baseUrl}/services`, { headers: asEzzahra });
    expect((afterEzzahra.body.data as { name: string }[]).map((s) => s.name)).toContain('Coupe Signature Ezzahra');

    // …et INVISIBLE dans Menzah 6, avec le même token, le même utilisateur, le même rôle.
    const afterMenzah = await fetchJson(`${testApp.baseUrl}/services`, { headers: asMenzah });
    const menzahNames = (afterMenzah.body.data as { name: string }[]).map((s) => s.name);
    expect(menzahNames).not.toContain('Coupe Signature Ezzahra');
    expect(afterMenzah.body.data).toHaveLength(4); // toujours son seul catalogue d'origine

    // Et en base, la donnée porte bien le salonId d'Ezzahra, jamais celui de Menzah 6.
    const raw = await testDb.db.collection('services').findOne({ name: 'Coupe Signature Ezzahra' });
    expect(raw?.salonId).toBe(tenantEzzahra);
  });

  it('MS-09: un tenant sur lequel Joshef n\'a AUCUN membership reste inaccessible (403)', async () => {
    const token = await login();
    const foreignTenant = new ObjectId().toString();
    const res = await fetchJson(`${testApp.baseUrl}/services`, {
      headers: { ...authHeader(token), 'x-tenant-id': foreignTenant },
    });
    expect(res.status).toBe(403);
  });

  // ── Étape 5 : le garde-fou ─────────────────────────────────────────────────

  it('MS-10: rejouer le rattachement du salon 2 → idempotent, aucun doublon créé', async () => {
    const res = await provision({
      tenantId: tenantMenzah,
      slug: 'joshef-menzah-6',
      name: 'Joshef Coif',
      locationLabel: 'Menzah 6',
      attachToExistingOwner: true,
      ownerUserId,
      owner: { name: 'Joshef Menzah 6', email: OWNER_EMAIL, phone: '+21699887766' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data.ownerStaffId).toBe(staffMenzahId);
    expect(res.body.data.ownerUserId).toBe(ownerUserId);

    expect(await testDb.db.collection('users').countDocuments({ identifier: OWNER_EMAIL })).toBe(1);
    expect(await testDb.db.collection('memberships').countDocuments({ userId: new ObjectId(ownerUserId) })).toBe(2);
    expect(await testDb.db.collection('staffs').countDocuments({ userId: new ObjectId(ownerUserId) })).toBe(2);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});
