/**
 * LC-1/LC-2/LC-7/LC-6.3/LC-8 — référentiel owner du loss control (SKILL_loss_control_doses.md,
 * Prompt 1). Trois preuves distinctes :
 *   [1] PATCH /products/:id/doses pose dosesPerUnit/isConsumable/varianceThresholdPct.
 *   [2] PATCH /services/:id/dose-config accepte plusieurs produits dosables.
 *   [3] LC-T8 : un produit non dosable (pas de dosesPerUnit, ou isConsumable:false) est refusé
 *       explicitement — un service ne peut pas référencer un produit retail pur.
 *   [4] PATCH /settings/loss-control merge champ par champ dans la sous-structure — ne
 *       touche AUCUN autre champ Salon (taxRate/currency/businessHours), contrairement au
 *       `$set: dto` brut de `updateSalon()`.
 *   [5] RBAC : les trois routes sont owner-only, un staff non-owner reçoit 403.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedService,
  signStaffJwt,
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control config (Prompt 1)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistUserId: string;
  let stylistStaffId: string;
  let serviceId: string;
  let productDosableId: ObjectId;
  let productDosable2Id: ObjectId;
  let productNotDosableId: ObjectId;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_config');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-config-salon' });
    tenantId = salon.tenantId;
    const locationId = salon.locations[0].id;

    const owner = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Patron',
    });
    ownerUserId = owner.userId;
    ownerStaffId = owner.staffId;

    const stylist = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Sarra',
    });
    stylistUserId = stylist.userId;
    stylistStaffId = stylist.staffId;

    const svc = await seedService(testDb.db, { tenantId, name: 'Coupe + coloration', price: 60, durationMin: 60 });
    serviceId = svc.serviceId;

    productDosableId = new ObjectId();
    productDosable2Id = new ObjectId();
    productNotDosableId = new ObjectId();
    // `products` est LOCATION_SCOPED (scoping-registry.ts) — le plugin de scope tenant injecte
    // `locationId: ctx.locationId` dans TOUTE query Mongoose sur cette collection. Un document
    // seedé sans `locationId` ne matche jamais (le filtre `{locationId: '...'}` ne matche pas
    // un champ absent) → 404 silencieux sur le PATCH doses. Doit être posé ici.
    await testDb.db.collection('products').insertMany([
      { _id: productDosableId, salonId: tenantId, locationId, name: 'Coloration Majirel', price: 25, stock: 10, active: true },
      { _id: productDosable2Id, salonId: tenantId, locationId, name: 'Oxydant 20 vol', price: 8, stock: 20, active: true },
      { _id: productNotDosableId, salonId: tenantId, locationId, name: 'Shampoing retail', price: 15, stock: 30, active: true },
    ]);
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });
  const stylistToken = () =>
    signStaffJwt({ sub: stylistUserId, salonId: tenantId, role: 'stylist', staffId: stylistStaffId });

  it('[1] PATCH /products/:id/doses sets dosesPerUnit/isConsumable, re-read from DB', async () => {
    const res = await fetchJson(url(`/products/${productDosableId.toString()}/doses`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ dosesPerUnit: 4, isConsumable: true, varianceThresholdPct: 25 }),
    });
    expect(res.status).toBe(200);

    const product = await testDb.db.collection('products').findOne({ _id: productDosableId });
    expect(product).toMatchObject({ dosesPerUnit: 4, isConsumable: true, varianceThresholdPct: 25 });
     
    console.log('PROOF [1] product:', JSON.stringify(product));

    // Second produit dosable, requis par la preuve [2] — pas de varianceThresholdPct (surcharge optionnelle).
    const res2 = await fetchJson(url(`/products/${productDosable2Id.toString()}/doses`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ dosesPerUnit: 8, isConsumable: true }),
    });
    expect(res2.status).toBe(200);
  });

  it('[2] PATCH /services/:id/dose-config accepts multiple dosable products, re-read from DB', async () => {
    const res = await fetchJson(url(`/services/${serviceId}/dose-config`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({
        doseConfig: [
          { productId: productDosableId.toString(), doses: 2 },
          { productId: productDosable2Id.toString(), doses: 1.5 },
        ],
      }),
    });
    expect(res.status).toBe(200);

    const service = await testDb.db.collection('services').findOne({ _id: new ObjectId(serviceId) });
    expect(service!.doseConfig).toHaveLength(2);
    expect(service!.doseConfig).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ productId: productDosableId.toString(), doses: 2 }),
        expect.objectContaining({ productId: productDosable2Id.toString(), doses: 1.5 }),
      ]),
    );
     
    console.log('PROOF [2] service.doseConfig:', JSON.stringify(service!.doseConfig));
  });

  it('[3] LC-T8: a doseConfig referencing a non-dosable product is refused with an explicit 400', async () => {
    const res = await fetchJson(url(`/services/${serviceId}/dose-config`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({
        doseConfig: [{ productId: productNotDosableId.toString(), doses: 1 }],
      }),
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/pas dosable/i);
     
    console.log('PROOF [3] 400 body:', JSON.stringify(res.body));

    // Le service.doseConfig posé en [2] doit être INCHANGÉ — le refus n'a rien écrit.
    const service = await testDb.db.collection('services').findOne({ _id: new ObjectId(serviceId) });
    expect(service!.doseConfig).toHaveLength(2);
  });

  it('[4] PATCH /settings/loss-control merges only lossControl.* — nothing else on Salon moves', async () => {
    // Baseline réaliste via le VRAI endpoint (pas le fixture raw-insert, qui ne pose pas les
    // sous-structures par défaut de Mongoose) — prouve l'absence de régression contre un
    // document déjà rempli, pas juste contre un doc vide.
    const seedRes = await fetchJson(url('/settings/salon'), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({
        taxRate: 7,
        currency: 'EUR',
        businessHours: [{ day: 1, isOpen: true, start: '10:00', end: '19:00' }],
      }),
    });
    expect(seedRes.status).toBe(200);

    const before = await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantId) });
    expect(before!.taxRate).toBe(7);
    expect(before!.currency).toBe('EUR');

    const res = await fetchJson(url('/settings/loss-control'), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ varianceThresholdPct: 20, alertsEnabled: true }),
    });
    expect(res.status).toBe(200);

    const after = await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantId) });
    expect(after!.lossControl).toMatchObject({
      varianceThresholdPct: 20,
      alertsEnabled: true,
      extremeUsageFactor: 2, // défaut, jamais envoyé — doit survivre
      productCommissionPct: 0, // défaut, jamais envoyé — doit survivre
    });

    // Chaque champ PRÉSENT avant (hors lossControl/updatedAt, bumpé par `timestamps:true`,
    // signal sans intérêt ici) doit avoir la MÊME valeur après — la seule garantie qui compte
    // pour A4. `.save()` (chemin `updateLossControl`, contrairement au `$set` brut
    // d'`updateSalon()`) backfille au passage les sous-structures jamais écrites du document
    // (`contact`, `landing`, `hours`, `address`, `phone`, `email`, `__v`) à leur DÉFAUT DE
    // SCHÉMA — un champ qui n'existait pas peut apparaître, mais aucune valeur déjà posée ne
    // peut changer.
    const { lossControl: _lcBefore, updatedAt: _uBefore, ...restBefore } = before as Record<string, unknown>;
    const { lossControl: _lcAfter, updatedAt: _uAfter, ...restAfter } = after as Record<string, unknown>;
    for (const [key, value] of Object.entries(restBefore)) {
      expect(restAfter[key]).toEqual(value);
    }

     
    console.log('PROOF [4] salon.lossControl:', JSON.stringify(after!.lossControl));
     
    console.log('PROOF [4] before (pre-existing fields):', JSON.stringify(restBefore));
     
    console.log('PROOF [4] after (same fields, same values + backfilled defaults):', JSON.stringify(restAfter));
  });

  it('[5] RBAC: a non-owner staff gets 403 on all three loss-control PATCH routes', async () => {
    const productRes = await fetchJson(url(`/products/${productDosableId.toString()}/doses`), {
      method: 'PATCH',
      headers: jsonHeaders(stylistToken()),
      body: JSON.stringify({ dosesPerUnit: 99 }),
    });
    expect(productRes.status).toBe(403);

    const serviceRes = await fetchJson(url(`/services/${serviceId}/dose-config`), {
      method: 'PATCH',
      headers: jsonHeaders(stylistToken()),
      body: JSON.stringify({ doseConfig: [] }),
    });
    expect(serviceRes.status).toBe(403);

    const settingsRes = await fetchJson(url('/settings/loss-control'), {
      method: 'PATCH',
      headers: jsonHeaders(stylistToken()),
      body: JSON.stringify({ alertsEnabled: false }),
    });
    expect(settingsRes.status).toBe(403);

     
    console.log('PROOF [5] statuses:', productRes.status, serviceRes.status, settingsRes.status);
  });
});
