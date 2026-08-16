/**
 * LC-8 — commission vente produit (SKILL_loss_control_doses.md, Prompt 6). Cinq preuves :
 *   [1] productCommissionPct=10 → productCommission = total_produit × 0,10, bon stylistId.
 *   [2] (clé) Ticket mixte service+produit → l'assiette ne porte QUE sur les lignes produit.
 *   [3] productCommissionPct=0 (défaut) → productCommission = 0.
 *   [4] (clé) Non-régression : la commission SERVICE existante (StaffProfile.commissionPct,
 *       arrondi à l'unité TND) est strictement inchangée.
 *   [5] Ticket multi-barbiers : chaque barbier reçoit la commission de SES lignes produit
 *       uniquement (un Payment par barbier, comme le split existant de charge()).
 */
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
  jsonHeaders,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control product commission (Prompt 6)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistAId: string;
  let stylistBId: string;
  let productId: ObjectId;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_product_commission');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-commission-salon' });
    tenantId = salon.tenantId;
    locationId = salon.locations[0].id;

    const owner = await seedStaff(testDb.db, {
      tenantId,
      role: 'owner',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Patron',
    });
    ownerUserId = owner.userId;
    ownerStaffId = owner.staffId;

    const stylistA = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Sarra',
    });
    stylistAId = stylistA.staffId;

    const stylistB = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Nadia',
    });
    stylistBId = stylistB.staffId;

    productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Shampoing pro',
      price: 15,
      stock: 100,
      active: true,
    });

    await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(signPosJwt({ staffId: stylistAId, salonId: tenantId, role: 'stylist' })),
      body: JSON.stringify({ openingFloat: 100 }),
    });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });
  const posToken = (staffId: string) => signPosJwt({ staffId, salonId: tenantId, role: 'stylist' });

  async function setProductCommissionPct(pct: number) {
    const res = await fetchJson(url('/settings/loss-control'), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ productCommissionPct: pct }),
    });
    expect(res.status).toBe(200);
  }

  it('[1] a product-only sale computes productCommission = total x pct, attributed to the right stylist', async () => {
    await setProductCommissionPct(10);

    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistAId)),
      body: JSON.stringify({
        stylistId: stylistAId,
        method: 'cash',
        items: [{ kind: 'product', refId: productId.toString(), name: 'Shampoing pro', qty: 2, unitPrice: 15 }],
      }),
    });
    expect(res.status).toBe(201);

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(res.body.data.paymentId) });
    // total produit = 2 x 15 = 30 ; 30 x 10% = 3.000
    expect(payment).toMatchObject({ productCommission: 3, commission: 0, stylistId: new ObjectId(stylistAId) });
     
    console.log('PROOF [1] productCommission:', payment!.productCommission, 'stylistId:', payment!.stylistId.toString());
  });

  it('[2] KEY: a mixed ticket (service + product) computes productCommission on the product line ONLY', async () => {
    // Commission service configurée aussi, pour prouver que les deux calculs restent séparés
    // (pas d'addition, pas de fuite d'assiette d'un côté vers l'autre).
    await testDb.db.collection('staffprofiles').insertOne({
      salonId: tenantId,
      userId: new ObjectId(stylistAId),
      level: 'senior',
      commissionPct: 20,
      baseRate: 0,
    });
    await setProductCommissionPct(10);

    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistAId)),
      body: JSON.stringify({
        stylistId: stylistAId,
        method: 'cash',
        items: [
          { kind: 'service', refId: new ObjectId().toString(), name: 'Coupe homme', qty: 1, unitPrice: 60 },
          { kind: 'product', refId: productId.toString(), name: 'Shampoing pro', qty: 1, unitPrice: 20 },
        ],
      }),
    });
    expect(res.status).toBe(201);

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(res.body.data.paymentId) });
    // Assiette produit = 20 (PAS 60+20=80) -> 20 x 10% = 2.000
    expect(payment!.productCommission).toBe(2);
    // Commission service INDÉPENDANTE : 60 x 20% = 12 (arrondi entier, cf. preuve [4])
    expect(payment!.commission).toBe(12);
     
    console.log('PROOF [2] mixed ticket -> productCommission:', payment!.productCommission, '(assiette produit only), commission (service):', payment!.commission);
  });

  it('[3] productCommissionPct=0 (default): productCommission is 0, no effect', async () => {
    await setProductCommissionPct(0);

    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistAId)),
      body: JSON.stringify({
        stylistId: stylistAId,
        method: 'cash',
        items: [{ kind: 'product', refId: productId.toString(), name: 'Shampoing pro', qty: 3, unitPrice: 15 }],
      }),
    });
    expect(res.status).toBe(201);
    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(res.body.data.paymentId) });
    expect(payment!.productCommission).toBe(0);
     
    console.log('PROOF [3] productCommissionPct=0 -> productCommission:', payment!.productCommission);
  });

  it('[4] KEY non-regression: the existing SERVICE commission is byte-for-byte unchanged (whole-TND rounding preserved)', async () => {
    await testDb.db.collection('staffprofiles').updateOne(
      { userId: new ObjectId(stylistBId) },
      { $set: { salonId: tenantId, userId: new ObjectId(stylistBId), level: 'senior', commissionPct: 33, baseRate: 0 } },
      { upsert: true },
    );
    await setProductCommissionPct(10); // délibérément non nul, pour prouver l'indépendance

    const res = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistBId)),
      body: JSON.stringify({
        stylistId: stylistBId,
        method: 'cash',
        items: [{ kind: 'service', refId: new ObjectId().toString(), name: 'Barbe', qty: 1, unitPrice: 25 }],
      }),
    });
    expect(res.status).toBe(201);

    const payment = await testDb.db.collection('payments').findOne({ _id: new ObjectId(res.body.data.paymentId) });
    // 25 x 33% = 8.25 -> Math.round(8.25) = 8 (arrondi ENTIER, comportement préexistant
    // inchangé — PAS 8.25, qui serait le résultat si le calcul service avait été "corrigé"
    // au passage vers l'arrondi 3-décimales de productCommission).
    expect(payment!.commission).toBe(8);
    expect(payment!.productCommission).toBe(0); // aucune ligne produit sur ce ticket
     
    console.log('PROOF [4] service commission unchanged: 25 x 33% ->', payment!.commission, '(whole-unit rounding, not 8.25)');
  });

  it('[5] a multi-stylist ticket: each stylist gets commission on their OWN product lines only', async () => {
    await setProductCommissionPct(10);

    // Reproduit le split par barbier de NewSaleView.charge() : un appel /pos/sale par barbier.
    const resA = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistAId)),
      body: JSON.stringify({
        stylistId: stylistAId,
        method: 'cash',
        items: [{ kind: 'product', refId: productId.toString(), name: 'Shampoing pro', qty: 1, unitPrice: 15 }],
      }),
    });
    const resB = await fetchJson(url('/pos/sale'), {
      method: 'POST',
      headers: jsonHeaders(posToken(stylistBId)),
      body: JSON.stringify({
        stylistId: stylistBId,
        method: 'cash',
        items: [{ kind: 'product', refId: productId.toString(), name: 'Shampoing pro', qty: 4, unitPrice: 15 }],
      }),
    });
    expect(resA.status).toBe(201);
    expect(resB.status).toBe(201);

    const paymentA = await testDb.db.collection('payments').findOne({ _id: new ObjectId(resA.body.data.paymentId) });
    const paymentB = await testDb.db.collection('payments').findOne({ _id: new ObjectId(resB.body.data.paymentId) });

    expect(paymentA).toMatchObject({ stylistId: new ObjectId(stylistAId), productCommission: 1.5 }); // 15 x 10%
    expect(paymentB).toMatchObject({ stylistId: new ObjectId(stylistBId), productCommission: 6 }); // 60 x 10%
     
    console.log('PROOF [5] stylistA productCommission:', paymentA!.productCommission, '- stylistB productCommission:', paymentB!.productCommission);
  });
});
