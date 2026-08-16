/**
 * LC-6 — les trois calculs d'écart (SKILL_loss_control_doses.md, Prompt 4). Jeu de données
 * CONNU, écarts calculés À LA MAIN puis comparés à la réponse de l'endpoint.
 *   [1] LC-T1 : service à 2 doses, déclaré 2 → écart 0 %.
 *   [2] LC-T14 : déclaré 0 pour 2 attendues → écart −100 %.
 *   [3] LC-T3 : +30 % sur 5 déclarations → Calc 1 agrégé ≈ 30 %.
 *   [4] LC-T4 (CLÉ) : baseline 10, refill +5, vendu 2, doses 4 (=1 unité, dosesPerUnit=4),
 *       inventaire final 9 → théorique 10+5−2−1=12, réel 9 (le PROCHAIN inventaire, pas
 *       Product.stock), écart −3 (−25 %).
 *   [5] hasBaseline:false — produit jamais inventorié, pas de 0 % trompeur.
 *   [6] LC-T2 : déclaré 5 pour 2 attendues, extremeUsageFactor=2 (5 > 4) → usage extrême.
 *   [7] Snapshot : changer le doseConfig APRÈS une déclaration ne réécrit pas son
 *       dosesExpected/variancePct passés.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedAppointment,
  signStaffJwt,
  signPosJwt,
  jsonHeaders,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control calculations (Prompt 4)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistAId: string;
  let stylistBId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_calc');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-calc-salon' });
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
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });

  it('[1]+[2] staff-honesty: per-product breakdown shows 0% (2 declared for 2 expected) and -100% (0 for 2)', async () => {
    const productP1 = new ObjectId().toString();
    const productP2 = new ObjectId().toString();

    await testDb.db.collection('doselogs').insertMany([
      {
        salonId: tenantId,
        appointmentId: new ObjectId().toString(),
        stylistId: stylistAId,
        serviceId: new ObjectId().toString(),
        productId: productP1,
        dosesDeclared: 2,
        dosesExpected: 2,
        variancePct: 0,
        declaredAt: new Date(),
      },
      {
        salonId: tenantId,
        appointmentId: new ObjectId().toString(),
        stylistId: stylistAId,
        serviceId: new ObjectId().toString(),
        productId: productP2,
        dosesDeclared: 0,
        dosesExpected: 2,
        variancePct: -100,
        declaredAt: new Date(),
      },
    ]);

    const res = await fetchJson(url(`/loss-control/staff-honesty?stylistId=${stylistAId}`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const staffRow = res.body.data.byStaff.find((s: { stylistId: string }) => s.stylistId === stylistAId);
    expect(staffRow).toMatchObject({ expected: 4, declared: 2, variancePct: -50 });

    const p1Row = staffRow.byProduct.find((p: { productId: string }) => p.productId === productP1);
    expect(p1Row).toMatchObject({ expected: 2, declared: 2, variancePct: 0 }); // [1] LC-T1

    const p2Row = staffRow.byProduct.find((p: { productId: string }) => p.productId === productP2);
    expect(p2Row).toMatchObject({ expected: 2, declared: 0, variancePct: -100 }); // [2] LC-T14

     
    console.log('PROOF [1] product', productP1, '-> 0%:', JSON.stringify(p1Row));
     
    console.log('PROOF [2] product', productP2, '-> -100%:', JSON.stringify(p2Row));
  });

  it('[3] LC-T3: +30% declared over 5 dose logs rolls up to ~30% on Calc 1', async () => {
    const rows = Array.from({ length: 5 }).map(() => ({
      salonId: tenantId,
      appointmentId: new ObjectId().toString(),
      stylistId: stylistBId,
      serviceId: new ObjectId().toString(),
      productId: new ObjectId().toString(),
      dosesDeclared: 13, // 10 * 1.3
      dosesExpected: 10,
      variancePct: 30,
      declaredAt: new Date(),
    }));
    await testDb.db.collection('doselogs').insertMany(rows);

    const res = await fetchJson(url(`/loss-control/staff-honesty?stylistId=${stylistBId}`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const staffRow = res.body.data.byStaff.find((s: { stylistId: string }) => s.stylistId === stylistBId);
    // expected 50, declared 65 -> (65-50)/50*100 = 30
    expect(staffRow).toMatchObject({ expected: 50, declared: 65, variancePct: 30 });
     
    console.log('PROOF [3] stylistB aggregate over 5 dose logs:', JSON.stringify(staffRow));
  });

  it('[6] LC-T2: 5 declared for 2 expected (factor 2, threshold 4) surfaces as extreme usage', async () => {
    const appointmentId = new ObjectId().toString();
    const productId = new ObjectId().toString();
    const extremeDoc = {
      salonId: tenantId,
      appointmentId,
      stylistId: stylistAId,
      serviceId: new ObjectId().toString(),
      productId,
      dosesDeclared: 5,
      dosesExpected: 2,
      variancePct: 150,
      declaredAt: new Date(),
    };
    await testDb.db.collection('doselogs').insertOne(extremeDoc);

    const res = await fetchJson(url('/loss-control/extreme-usage'), { headers: authHeader(ownerToken()) });
    expect(res.status).toBe(200);
    const match = res.body.data.find((r: { appointmentId: string }) => r.appointmentId === appointmentId);
    expect(match).toMatchObject({ dosesDeclared: 5, dosesExpected: 2, extremeUsageFactor: 2, appointmentId });

    // Le DoseLog "0 déclaré pour 2 attendus" du test [2] (variance -100%, sous-déclaration)
    // n'est PAS un usage EXTRÊME (5 > 2*2 est la condition, pas |écart| élevé) — jamais présent ici.
    const noneOverDeclaring = res.body.data.filter((r: { dosesDeclared: number; dosesExpected: number }) => r.dosesDeclared <= r.dosesExpected * 2);
    expect(noneOverDeclaring).toHaveLength(0);

     
    console.log('PROOF [6] extreme usage entries:', res.body.data.length, '-> match:', JSON.stringify(match));
  });

  it('[5] hasBaseline:false for a product with no physical inventory ever recorded', async () => {
    const productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Produit jamais compté',
      price: 10,
      stock: 42,
      active: true,
    });

    const res = await fetchJson(url(`/loss-control/variance?productId=${productId.toString()}`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    expect(res.body.data.hasBaseline).toBe(false);
    expect(res.body.data.variancePct).toBeUndefined();
    expect(res.body.data.stockTheoretical).toBeUndefined();
     
    console.log('PROOF [5] no baseline:', JSON.stringify(res.body.data));
  });

  it('[4] KEY: hand-verified stock variance — baseline 10, refill +5, sold 2, 4 doses declared (=1 unit), next count 9', async () => {
    const productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Coloration Majirel',
      price: 25,
      stock: 999, // volontairement absurde — la preuve doit ignorer Product.stock au profit du PROCHAIN inventaire
      dosesPerUnit: 4,
      isConsumable: true,
      active: true,
    });

    const now = Date.now();
    const t0 = new Date(now - 5000); // baseline
    const t1 = new Date(now - 4000); // refill
    const t2 = new Date(now - 3000); // vente
    const t3 = new Date(now - 2000); // doses déclarées
    const t4 = new Date(now - 1000); // inventaire final

    await testDb.db.collection('stockmoves').insertMany([
      { salonId: tenantId, locationId, productId, kind: 'inventory', type: 'in', qty: 10, previousStock: 0, variance: 10, date: t0 },
      { salonId: tenantId, locationId, productId, kind: 'refill', type: 'in', qty: 5, date: t1 },
      { salonId: tenantId, locationId, productId, kind: 'inventory', type: 'out', qty: 9, previousStock: 999, variance: -990, date: t4 },
    ]);

    await testDb.db.collection('sales').insertOne({
      salonId: tenantId,
      locationId,
      source: 'pos',
      items: [{ refId: productId.toString(), name: 'Coloration Majirel', qty: 2, unitPrice: 25 }],
      subtotal: 50,
      total: 50,
      date: t2,
      voided: false,
      stockRestored: false,
    });

    await testDb.db.collection('doselogs').insertOne({
      salonId: tenantId,
      appointmentId: new ObjectId().toString(),
      stylistId: stylistAId,
      serviceId: new ObjectId().toString(),
      productId: productId.toString(),
      dosesDeclared: 4,
      dosesExpected: 4,
      variancePct: 0,
      declaredAt: t3,
    });

    const res = await fetchJson(url(`/loss-control/variance?productId=${productId.toString()}`), {
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const data = res.body.data;

    // Calcul à la main : théorique = 10 (baseline) + 5 (refill) - 0 (loss) + 0 (adjustment)
    //                               - 2 (vendu) - (4 doses / 4 dosesPerUnit = 1 unité) = 12
    //                    réel = 9 (PROCHAIN inventaire, PAS Product.stock=999)
    //                    écart = réel - théorique = 9 - 12 = -3
    //                    variancePct = -3 / 12 * 100 = -25%
    expect(data.hasBaseline).toBe(true);
    expect(data.breakdown).toMatchObject({ refill: 5, loss: 0, adjustment: 0, sold: 2, consumedUnits: 1 });
    expect(data.stockTheoretical).toBe(12);
    expect(data.stockReal).toBe(9); // prouve l'usage du PROCHAIN inventaire, pas Product.stock (999)
    expect(data.variance).toBe(-3);
    expect(data.variancePct).toBe(-25);

     
    console.log('PROOF [4] KEY variance result:', JSON.stringify(data));
  });

  it('[7] snapshot: changing a service doseConfig AFTER a declaration does not rewrite its dosesExpected/variancePct', async () => {
    const productId = new ObjectId();
    await testDb.db.collection('products').insertOne({
      _id: productId,
      salonId: tenantId,
      locationId,
      name: 'Oxydant',
      price: 8,
      stock: 20,
      dosesPerUnit: 8,
      isConsumable: true,
      active: true,
    });

    const serviceObjId = new ObjectId();
    await testDb.db.collection('services').insertOne({
      _id: serviceObjId,
      salonId: tenantId,
      name: 'Balayage',
      category: '',
      gender: 'universal',
      price: 80,
      durationMin: 90,
      bufferMin: 0,
      color: '#B89968',
      active: true,
      isFeatured: false,
      featuredOrder: 0,
      isPublic: true,
      doseConfig: [{ productId: productId.toString(), doses: 2 }],
    });

    const start = new Date();
    const end = new Date(start.getTime() + 90 * 60_000);
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistAId,
      clientId: new ObjectId().toString(),
      start,
      end,
      status: 'booked',
      services: [serviceObjId.toString()],
    });

    const declareRes = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(signPosJwt({ staffId: stylistAId, salonId: tenantId, role: 'stylist' })),
      body: JSON.stringify({ lines: [{ productId: productId.toString(), dosesDeclared: 2 }] }),
    });
    expect(declareRes.status).toBe(201);

    const before = await testDb.db.collection('doselogs').findOne({ appointmentId, productId: productId.toString() });
    expect(before).toMatchObject({ dosesExpected: 2, dosesDeclared: 2, variancePct: 0 });

    // L'owner change le théorique du service APRÈS la déclaration.
    const patchRes = await fetchJson(url(`/services/${serviceObjId.toString()}/dose-config`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ doseConfig: [{ productId: productId.toString(), doses: 5 }] }),
    });
    expect(patchRes.status).toBe(200);

    const after = await testDb.db.collection('doselogs').findOne({ appointmentId, productId: productId.toString() });
    expect(after).toMatchObject({ dosesExpected: 2, dosesDeclared: 2, variancePct: 0 }); // INCHANGÉ

    // L'agrégat Calc 1 lit aussi le snapshot, jamais le doseConfig courant.
    const honestyRes = await fetchJson(url(`/loss-control/staff-honesty?stylistId=${stylistAId}`), {
      headers: authHeader(ownerToken()),
    });
    const productRow = honestyRes.body.data.byStaff
      .find((s: { stylistId: string }) => s.stylistId === stylistAId)
      .byProduct.find((p: { productId: string }) => p.productId === productId.toString());
    expect(productRow).toMatchObject({ expected: 2, declared: 2, variancePct: 0 });

     
    console.log('PROOF [7] doseConfig changed to 5 doses, DoseLog snapshot before/after:', JSON.stringify(before), '->', JSON.stringify(after));
  });
});
