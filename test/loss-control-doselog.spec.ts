/**
 * LC-3/LC-4 — déclaration de doses par le staff au POS (SKILL_loss_control_doses.md,
 * Prompt 2). Sept preuves :
 *   [1] Déclaration sur un RDV booked → 201, dosesExpected résolu depuis doseConfig,
 *       variancePct calculé — sur un service consommant 2 produits (couvre aussi LC-T12,
 *       preuve [7] : 2 DoseLog, écarts calculés séparément).
 *   [2] Re-déclaration (même produit) → upsert, pas de doublon.
 *   [3] LC-T6 : déclaration après clôture → 409.
 *   [4] Verrouillage : clôturer un RDV pose lockedAt sur ses DoseLog.
 *   [5] Correction owner post-verrouillage → 200, correctedBy/correctionNote tracés.
 *   [6] RBAC : un staff (non-owner) tente PATCH /doses/:id → 403.
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
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('loss-control DoseLog (Prompt 2)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;
  let stylistUserId: string;
  let stylistStaffId: string;
  let serviceId: string;
  let productAId: ObjectId; // doseConfig: 2 doses
  let productBId: ObjectId; // doseConfig: 1 dose
  let appointmentId: string;

  const url = (p: string) => `${testApp.baseUrl}${p}`;

  beforeAll(async () => {
    testDb = await startTestDb('loss_control_doselog');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'lc-doselog-salon' });
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

    const stylist = await seedStaff(testDb.db, {
      tenantId,
      role: 'stylist',
      locationIds: [locationId],
      defaultLocationId: locationId,
      name: 'Sarra',
    });
    stylistUserId = stylist.userId;
    stylistStaffId = stylist.staffId;

    productAId = new ObjectId();
    productBId = new ObjectId();
    await testDb.db.collection('products').insertMany([
      {
        _id: productAId,
        salonId: tenantId,
        locationId,
        name: 'Coloration Majirel',
        price: 25,
        stock: 10,
        dosesPerUnit: 4,
        isConsumable: true,
        active: true,
      },
      {
        _id: productBId,
        salonId: tenantId,
        locationId,
        name: 'Oxydant 20 vol',
        price: 8,
        stock: 20,
        dosesPerUnit: 8,
        isConsumable: true,
        active: true,
      },
    ]);

    const serviceObjId = new ObjectId();
    serviceId = serviceObjId.toString();
    await testDb.db.collection('services').insertOne({
      _id: serviceObjId,
      salonId: tenantId,
      name: 'Coloration complète',
      category: '',
      gender: 'universal',
      price: 60,
      durationMin: 60,
      bufferMin: 0,
      color: '#B89968',
      active: true,
      isFeatured: false,
      featuredOrder: 0,
      isPublic: true,
      // Un service consommant 2 produits (LC-T12) — le théorique attendu par ce Prompt.
      doseConfig: [
        { productId: productAId.toString(), doses: 2 },
        { productId: productBId.toString(), doses: 1 },
      ],
    });

    const start = new Date();
    const end = new Date(start.getTime() + 60 * 60_000);
    const appt = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: stylistStaffId,
      clientId: new ObjectId().toString(), // aucun DoseLog ne déréférence le client
      start,
      end,
      status: 'booked',
      services: [serviceId],
    });
    appointmentId = appt.appointmentId;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  const stylistPosToken = () => signPosJwt({ staffId: stylistStaffId, salonId: tenantId, role: 'stylist' });
  const ownerToken = () => signStaffJwt({ sub: ownerUserId, salonId: tenantId, role: 'owner', staffId: ownerStaffId });
  const stylistToken = () =>
    signStaffJwt({ sub: stylistUserId, salonId: tenantId, role: 'stylist', staffId: stylistStaffId });

  let firstDoseLogId: string;

  it('[1]+[7] declaring on a booked appointment resolves dosesExpected from doseConfig, computes variancePct (2 products, LC-T12)', async () => {
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({
        lines: [
          { productId: productAId.toString(), dosesDeclared: 3 }, // expected 2 -> +50%
          { productId: productBId.toString(), dosesDeclared: 1 }, // expected 1 -> 0%
        ],
      }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toHaveLength(2);

    const logs = await testDb.db
      .collection('doselogs')
      .find({ appointmentId })
      .sort({ productId: 1 })
      .toArray();
    expect(logs).toHaveLength(2);

    const logA = logs.find((l) => l.productId === productAId.toString())!;
    expect(logA).toMatchObject({ dosesDeclared: 3, dosesExpected: 2, variancePct: 50, stylistId: stylistStaffId, serviceId });
    firstDoseLogId = logA._id.toString();

    const logB = logs.find((l) => l.productId === productBId.toString())!;
    expect(logB).toMatchObject({ dosesDeclared: 1, dosesExpected: 1, variancePct: 0 });

     
    console.log('PROOF [1]/[7] DoseLog x2:', JSON.stringify(logs));
  });

  it('[extra] declaring a product outside doseConfig is refused (400)', async () => {
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: new ObjectId().toString(), dosesDeclared: 1 }] }),
    });
    expect(res.status).toBe(400);
  });

  it('[2] re-declaring the same product upserts — no duplicate', async () => {
    const res = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: productAId.toString(), dosesDeclared: 4 }] }),
    });
    expect(res.status).toBe(201);

    const count = await testDb.db.collection('doselogs').countDocuments({ appointmentId });
    expect(count).toBe(2); // toujours 2 — pas 3

    const logA = await testDb.db.collection('doselogs').findOne({ appointmentId, productId: productAId.toString() });
    expect(logA).toMatchObject({ dosesDeclared: 4, dosesExpected: 2, variancePct: 100 });
     
    console.log('PROOF [2] count after re-declare:', count, '— productA now:', JSON.stringify(logA));
  });

  it('[3]+[4] checking out the appointment locks its DoseLog and refuses further declaration (LC-T6)', async () => {
    await fetchJson(url('/caisse/session/open'), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ openingFloat: 100 }),
    });

    const payRes = await fetchJson(url(`/pos/appointments/${appointmentId}/pay`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(payRes.status).toBe(201);

    const appt = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(appt!.status).toBe('completed');

    // [4] verrouillage : lockedAt posé sur les 2 DoseLog de ce RDV.
    const logs = await testDb.db.collection('doselogs').find({ appointmentId }).toArray();
    expect(logs).toHaveLength(2);
    for (const log of logs) expect(log.lockedAt).toBeTruthy();
     
    console.log('PROOF [4] lockedAt:', logs.map((l) => l.lockedAt));

    // [3] LC-T6 : toute nouvelle déclaration sur ce RDV est refusée.
    const declareAfter = await fetchJson(url(`/pos/appointments/${appointmentId}/doses`), {
      method: 'POST',
      headers: jsonHeaders(stylistPosToken()),
      body: JSON.stringify({ lines: [{ productId: productAId.toString(), dosesDeclared: 1 }] }),
    });
    expect(declareAfter.status).toBe(409);
     
    console.log('PROOF [3] declare-after-lock status:', declareAfter.status, declareAfter.body.message);
  });

  it('[5] owner correction after lock is accepted, traced (correctedBy/correctionNote)', async () => {
    const res = await fetchJson(url(`/doses/${firstDoseLogId}`), {
      method: 'PATCH',
      headers: jsonHeaders(ownerToken()),
      body: JSON.stringify({ dosesDeclared: 2, correctionNote: 'Vérifié en rayon, écart non confirmé.' }),
    });
    expect(res.status).toBe(200);

    const log = await testDb.db.collection('doselogs').findOne({ _id: new ObjectId(firstDoseLogId) });
    expect(log).toMatchObject({
      dosesDeclared: 2,
      dosesExpected: 2, // snapshot inchangé
      variancePct: 0,
      correctedBy: ownerStaffId,
      correctionNote: 'Vérifié en rayon, écart non confirmé.',
    });
     
    console.log('PROOF [5] corrected DoseLog:', JSON.stringify(log));
  });

  it('[6] RBAC: a non-owner staff gets 403 on PATCH /doses/:id', async () => {
    const res = await fetchJson(url(`/doses/${firstDoseLogId}`), {
      method: 'PATCH',
      headers: jsonHeaders(stylistToken()),
      body: JSON.stringify({ dosesDeclared: 99, correctionNote: 'tentative staff' }),
    });
    expect(res.status).toBe(403);
     
    console.log('PROOF [6] staff correction attempt status:', res.status);
  });
});
