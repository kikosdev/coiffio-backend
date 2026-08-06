/**
 * SKILL Prompt 9, suite 8 — routes publiques storefront (`:salonSlug`, Prompt 6 Partie C /
 * `GuestScopeService`). 200 slug valide, 404 slug inconnu (jamais 500), filtrage locationId,
 * non-exposition des données non-publiques en contexte guest.
 */
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedService,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';

describe('storefront-guest (public :salonSlug routes)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let locA: string;
  let locB: string;
  let stylistLocAOnly: { staffId: string; userId: string };

  beforeAll(async () => {
    testDb = await startTestDb('storefront_guest');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'guest-storefront-salon', locationSlugs: ['loc-a', 'loc-b'] });
    tenantId = salon.tenantId;
    locA = salon.locations[0].id;
    locB = salon.locations[1].id;
    await seedService(testDb.db, { tenantId, name: 'Public Service', isPublic: true, active: true });
    await seedService(testDb.db, { tenantId, name: 'Hidden Inactive Service', isPublic: true, active: false });
    stylistLocAOnly = await seedStaff(testDb.db, { tenantId, role: 'stylist', locationIds: [locA], defaultLocationId: locA, name: 'Loc A Only Stylist' });
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  it('valid slug → 200', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/book/services`);
    expect(res.status).toBe(200);
  });

  it('unknown slug → 404, never 500', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/this-slug-does-not-exist/book/services`);
    expect(res.status).toBe(404);
  });

  it('unknown slug on the orders/shop storefront → 404, never 500', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/this-slug-does-not-exist/shop/products`);
    expect(res.status).toBe(404);
  });

  it('inactive services are never exposed on the public catalog', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/book/services`);
    expect(res.status).toBe(200);
    const names = (res.body.data as any[]).map((s) => s.name);
    expect(names).toContain('Public Service');
    expect(names).not.toContain('Hidden Inactive Service');
  });

  it('locationId filtering: a stylist attached to location A only is absent when browsing location B', async () => {
    const svc = await seedService(testDb.db, { tenantId, name: 'Filter Test Service' });
    const resA = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/availability?date=2026-09-15&locationId=${locA}&serviceId=${svc.serviceId}`);
    const resB = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/availability?date=2026-09-15&locationId=${locB}&serviceId=${svc.serviceId}`);
    expect(resA.status).toBe(200);
    expect(resB.status).toBe(200);
    const stylistIdsB = (resB.body.data as any[]).map((s) => s.stylistId);
    expect(stylistIdsB).not.toContain(stylistLocAOnly.staffId);
  });

  it('a guest (no JWT) cannot reach staff-only routes — 401, not silently scoped through', async () => {
    const [clients, team, reports] = await Promise.all([
      fetchJson(`${testApp.baseUrl}/clients`),
      fetchJson(`${testApp.baseUrl}/team`),
      fetchJson(`${testApp.baseUrl}/reports`),
    ]);
    expect(clients.status).toBe(401);
    expect(team.status).toBe(401);
    expect(reports.status).toBe(401);
  });

  // Durcissement post-Sprint-1-v2 Partie 2 (trouvé au Prompt 9, corrigé ici) : `catalog()`
  // exposait le document `Service` complet — `salonId` compris — sur cette route publique.
  // Projection sur les champs publics uniquement désormais (`CATALOG_PUBLIC_FIELDS`).
  it('the public catalog only exposes public service fields — never salonId or internal management fields', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/book/services`);
    expect(res.status).toBe(200);
    const svc = (res.body.data as any[]).find((s) => s.name === 'Public Service');
    expect(svc).toBeDefined();
    // Champs publics attendus, réellement consommés par le storefront.
    expect(svc.name).toBe('Public Service');
    expect(svc.category).toBeDefined();
    expect(svc.gender).toBeDefined();
    expect(svc.price).toBeDefined();
    expect(svc.durationMin).toBeDefined();
    // Jamais salonId (ObjectId interne) ni les champs de gestion interne.
    expect(svc.salonId).toBeUndefined();
    expect(svc.isFeatured).toBeUndefined();
    expect(svc.featuredOrder).toBeUndefined();
    expect(svc.isPublic).toBeUndefined();
    expect(svc.bufferMin).toBeUndefined();
    expect(svc.active).toBeUndefined();
  });

  it('the public catalog response never leaks another tenant\'s salonId (no cross-tenant leakage, belt-and-suspenders)', async () => {
    const otherSalon = await seedSalon(testDb.db, { slug: 'guest-storefront-other-tenant' });
    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/book/services`);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(otherSalon.tenantId);
  });

  // ── Durcissement post-Sprint-1-v2 Partie 1 (trou trouvé au Prompt 6, fermé avant Sprint 2)
  // : `clients` est désormais hors GUEST_READABLE. `resolveClient()` (booking) et
  // `OrdersService.resolveClient()` (checkout) ont besoin d'une lecture `clients` bornée
  // (dédup merge-on-phone) sous ces mêmes routes guest — ces deux tests prouvent que les
  // parcours réels (booking en ligne, checkout invité) fonctionnent toujours après le
  // durcissement, pas juste en théorie.

  it('shop products (public, guest) still works after the guest whitelist hardening', async () => {
    await testDb.db.collection('products').insertOne({
      salonId: tenantId, locationId: locA,
      name: 'Shampoo', category: 'Hair', price: 25, cost: 10, stock: 5, lowStockAt: 1,
      supplier: '', barcode: '', notes: '', visibleLanding: true, promo: false, promoPercent: 0,
      promoLabel: '', active: true, salesCount: 0,
    });
    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/shop/products`);
    expect(res.status).toBe(200);
    expect((res.body.data as any[]).some((p) => p.name === 'Shampoo')).toBe(true);
  });

  it('a real online booking (guest, POST /:salonSlug/appointments, new client by phone) still works after the guest whitelist hardening', async () => {
    const stylist = await seedStaff(testDb.db, {
      tenantId, role: 'stylist', locationIds: [locA], defaultLocationId: locA, name: 'Booking Test Stylist',
    });
    const svc = await seedService(testDb.db, { tenantId, name: 'Online Booking Service', durationMin: 30 });

    const res = await fetchJson(`${testApp.baseUrl}/guest-storefront-salon/appointments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serviceIds: [svc.serviceId],
        stylistId: stylist.staffId,
        start: '2026-10-01T09:00:00.000Z',
        clientName: 'Guest Booker',
        clientPhone: '+21620555444',
        source: 'online',
      }),
    });
    expect(res.status).toBeLessThan(500);
    expect(res.status).toBe(201);

    // Relu depuis la base : le client a bien été créé/dédupliqué par téléphone, sous le bon
    // tenant, sans jamais passer par le contexte guest ambiant pour la lecture `clients`.
    const client = await testDb.db.collection('clients').findOne({ salonId: tenantId, phone: '+21620555444' });
    expect(client).not.toBeNull();
    expect(client?.name).toBe('Guest Booker');

    // `emitBookingCreated`'s notification dispatch is fire-and-forget (`void`, by design —
    // convention #7 persist-then-emit, never blocking the booking response). Laisse-la se
    // terminer avant que le test (et `afterAll`) ne ferme la connexion Mongo sous ses pieds —
    // sinon la promesse détachée échoue en plein vol sur un client fermé, cassant la suite.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('a real guest checkout (cart cookie → POST /:salonSlug/orders, new client by phone) still works after the guest whitelist hardening', async () => {
    await testDb.db.collection('products').insertOne({
      salonId: tenantId, locationId: locA,
      name: 'Checkout Test Product', category: '', price: 40, cost: 10, stock: 5, lowStockAt: 1,
      supplier: '', barcode: '', notes: '', visibleLanding: true, promo: false, promoPercent: 0,
      promoLabel: '', active: true, salesCount: 0,
    });
    const product = await testDb.db.collection('products').findOne({ name: 'Checkout Test Product' });

    const addRes = await fetch(`${testApp.baseUrl}/guest-storefront-salon/cart/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: product!._id.toString(), qty: 1 }),
    });
    expect(addRes.status).toBeLessThan(500);
    expect(addRes.status).toBe(201);
    const setCookie = addRes.headers.get('set-cookie') ?? '';
    const cartTokenMatch = setCookie.match(/cartToken=([^;]+)/);
    expect(cartTokenMatch).not.toBeNull();
    const cookieHeader = `cartToken=${cartTokenMatch![1]}`;

    const checkoutRes = await fetch(`${testApp.baseUrl}/guest-storefront-salon/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ name: 'Guest Shopper', phone: '+21620666777', email: 'guest-shopper@test.tn' }),
    });
    expect(checkoutRes.status).toBeLessThan(500);
    expect(checkoutRes.status).toBe(201);

    const client = await testDb.db.collection('clients').findOne({ salonId: tenantId, phone: '+21620666777' });
    expect(client).not.toBeNull();
    expect(client?.name).toBe('Guest Shopper');

    // Même raison que le test de booking en ligne ci-dessus : `checkout()` dispatch aussi en
    // fire-and-forget (ORDER_CREATED) — laisse-le se terminer avant la fermeture de la DB.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
});
