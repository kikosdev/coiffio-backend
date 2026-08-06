/**
 * DP-SWEEP (Sprint 3 v2 CP, prérequis du Prompt 5 impersonation) — le plumbing
 * impersonation (JWT→contexte→log) existait déjà, mais rien ne bloquait une action
 * destructrice faite SOUS impersonation avant `DestructiveGuard`. Ce fichier prouve :
 *   1. Le mécanisme générique du guard (metadata-driven, no-op par défaut).
 *   2. Les 15 routes marquées `@Destructive()` sur les 10 contrôleurs balayés → 403
 *      IMPERSONATION_READONLY sous impersonation (guard global, bloque AVANT le handler —
 *      donc pas besoin de données réelles pour chaque route, un id factice suffit).
 *   3. Un usage normal (sans impersonation) sur une route `@Destructive()` n'est JAMAIS
 *      bloqué — vérifié bout en bout (donnée réellement modifiée en base).
 *   4. Une route NON marquée `@Destructive()` n'est jamais bloquée, même sous
 *      impersonation — le guard ne doit fermer QUE ce qui est explicitement listé.
 *   5. Le cas `booking.controller.ts` `cancel()` (contexte posé PLUS TARD, dans le handler,
 *      via `GuestScopeService.run()` pour un guest sans JWT) — preuve que le choix de
 *      `tenantStorage.getStore()` (tolérant à l'absence de contexte) plutôt que
 *      `getTenantContext()` (qui throw) ne casse pas l'annulation guest légitime.
 *   6. La requête impersonation reste loggée (comportement déjà en place, non touché par
 *      ce sweep — juste reconfirmé).
 */
import { Logger } from '@nestjs/common';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  seedSalon,
  seedStaff,
  seedClient,
  seedService,
  seedAppointment,
  signStaffJwt,
  authHeader,
  fetchJson,
  TestDb,
  TestApp,
} from './utils/test-app';
import { signAppointment } from '../src/booking/signed-link.util';

const FAKE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

describe('DP-SWEEP — @Destructive() guard', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let tenantId: string;
  let slug: string;
  let locationId: string;
  let ownerUserId: string;
  let ownerStaffId: string;

  beforeAll(async () => {
    testDb = await startTestDb('destructive_sweep');
    testApp = await bootApp();
    const salon = await seedSalon(testDb.db, { slug: 'destructive-sweep-salon' });
    tenantId = salon.tenantId;
    slug = salon.slug;
    locationId = salon.locations[0].id;
    const owner = await seedStaff(testDb.db, { tenantId, role: 'owner', locationIds: [locationId], defaultLocationId: locationId });
    ownerUserId = owner.userId;
    ownerStaffId = owner.staffId;
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  function ownerToken(impersonatedBy?: string): string {
    return signStaffJwt({
      sub: ownerUserId,
      salonId: tenantId,
      role: 'owner',
      staffId: ownerStaffId,
      ...(impersonatedBy ? { impersonatedBy, impersonationReason: 'support ticket #DP-SWEEP' } : {}),
    });
  }

  // Les 15 routes @Destructive() ajoutées par ce sweep, sur les 10 contrôleurs touchés.
  // Le guard bloque AVANT le handler (APP_GUARD global, exécuté avant les @UseGuards()
  // par contrôleur/méthode) — un id factice suffit, aucune donnée réelle n'est requise
  // pour prouver le 403.
  const DESTRUCTIVE_ROUTES: Array<{ label: string; method: string; path: string; body?: unknown }> = [
    { label: 'team.controller: DELETE :id/access (revokeAccess)', method: 'DELETE', path: `/team/${FAKE_ID}/access` },
    { label: 'team.controller: DELETE :id (deactivate)', method: 'DELETE', path: `/team/${FAKE_ID}` },
    { label: 'schedule.controller: DELETE :stylistId/override/:date (removeOverride)', method: 'DELETE', path: `/schedule/${FAKE_ID}/override/2026-01-01` },
    { label: 'stock.controller: DELETE products/:id (remove)', method: 'DELETE', path: `/products/${FAKE_ID}` },
    { label: 'orders.controller: PATCH orders/:id/status (status)', method: 'PATCH', path: `/orders/${FAKE_ID}/status`, body: { status: 'cancelled' } },
    { label: 'settings.controller: DELETE roles/:id (deleteRole)', method: 'DELETE', path: `/settings/roles/${FAKE_ID}` },
    { label: 'services.controller: DELETE :id (remove)', method: 'DELETE', path: `/services/${FAKE_ID}` },
    { label: 'location.controller: DELETE :id (remove)', method: 'DELETE', path: `/locations/${FAKE_ID}` },
    { label: 'sales.controller: DELETE sales/:id (voidSale)', method: 'DELETE', path: `/sales/${FAKE_ID}` },
    { label: 'invitation.controller: DELETE :id (revoke)', method: 'DELETE', path: `/invitations/${FAKE_ID}` },
    { label: 'finance.controller: POST payments/:id/refund (refund)', method: 'POST', path: `/payments/${FAKE_ID}/refund` },
    { label: 'finance.controller: DELETE expenses/:id (deleteExpense)', method: 'DELETE', path: `/expenses/${FAKE_ID}` },
    { label: 'booking.controller: PATCH :salonSlug/appointments/:id/cancel (cancel)', method: 'PATCH', path: `/${'destructive-sweep-salon'}/appointments/${FAKE_ID}/cancel`, body: {} },
    { label: 'auth.controller: PATCH me/password (changePassword)', method: 'PATCH', path: `/auth/me/password`, body: { currentPassword: 'x', newPassword: 'y-12345678' } },
    { label: 'auth.controller: PATCH me/deactivate (deactivateMe)', method: 'PATCH', path: `/auth/me/deactivate` },
  ];

  it.each(DESTRUCTIVE_ROUTES)('$label — impersonated owner token → 403 IMPERSONATION_READONLY', async ({ method, path, body }) => {
    const res = await fetchJson(`${testApp.baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken('cp-admin-42')) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    expect(res.status).toBe(403);
    expect(res.body.data).toMatchObject({ code: 'IMPERSONATION_READONLY' });
  });

  it('@Destructive() route, NO impersonation → works normally (services.remove really soft-deletes)', async () => {
    const { serviceId } = await seedService(testDb.db, { tenantId, name: 'To Delete' });
    const res = await fetchJson(`${testApp.baseUrl}/services/${serviceId}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const { ObjectId } = await import('mongodb');
    const reread = await testDb.db.collection('services').findOne({ _id: new ObjectId(serviceId) });
    expect(reread?.active).toBe(false);
  });

  it('@Destructive() route, NO impersonation → works normally (team.deactivate really deactivates)', async () => {
    const target = await seedStaff(testDb.db, { tenantId, role: 'manager', locationIds: [locationId], defaultLocationId: locationId, name: 'To Deactivate' });
    const res = await fetchJson(`${testApp.baseUrl}/team/${target.staffId}`, {
      method: 'DELETE',
      headers: authHeader(ownerToken()),
    });
    expect(res.status).toBe(200);
    const { ObjectId } = await import('mongodb');
    const reread = await testDb.db.collection('staffs').findOne({ _id: new ObjectId(target.staffId) });
    expect(reread?.isActive).toBe(false);
  });

  it('non-@Destructive() route, WITH impersonation → not blocked (guard is selective, not blind)', async () => {
    const { serviceId } = await seedService(testDb.db, { tenantId, name: 'Update Me' });
    const res = await fetchJson(`${testApp.baseUrl}/services/${serviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...authHeader(ownerToken('cp-admin-42')) },
      body: JSON.stringify({ name: 'Updated Under Impersonation' }),
    });
    expect(res.status).toBe(200);
  });

  it('booking.cancel: real GUEST (no JWT at all, signed link token) → cancels normally — proves tenantStorage.getStore() undefined-context tolerance is safe in practice', async () => {
    const client = await seedClient(testDb.db, { tenantId, phone: '+21620000001' });
    const owner = { staffId: ownerStaffId };
    const start = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 30 * 60 * 1000);
    const { appointmentId } = await seedAppointment(testDb.db, {
      tenantId,
      locationId,
      stylistId: owner.staffId,
      clientId: client.clientId,
      start,
      end,
    });
    const token = signAppointment(appointmentId);

    const res = await fetchJson(`${testApp.baseUrl}/${slug}/appointments/${appointmentId}/cancel`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' }, // pas d'Authorization — vrai guest
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(200);

    const { ObjectId } = await import('mongodb');
    const reread = await testDb.db.collection('appointments').findOne({ _id: new ObjectId(appointmentId) });
    expect(reread?.status).toBe('cancelled');

    // `cancel()` dispatch une notification fire-and-forget (`void`) — laisse-la se terminer.
    await new Promise((resolve) => setTimeout(resolve, 50));
  });

  it('impersonated request still gets logged (pre-existing TenantContextMiddleware behavior, untouched by this sweep)', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    try {
      await fetchJson(`${testApp.baseUrl}/services`, {
        headers: authHeader(ownerToken('cp-admin-log-check')),
      });
      const calls = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(calls.some((m) => m.includes('Impersonated request') && m.includes('cp-admin-log-check'))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
