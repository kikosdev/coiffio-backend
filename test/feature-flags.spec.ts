/**
 * Sprint 3 v2 — Prompt 7, partie DP du Delta 3 (feature flags). "Aujourd'hui RIEN ne lit de
 * flags → vraie tâche DP" (SKILL) : ce fichier prouve que `EntitlementsJwtPayload.flags?`
 * est correctement fusionné dans `ResolvedEntitlements`/`TenantContext.flags`, et qu'un
 * comportement RÉEL en dépend (`EntitlementsService.checkSoftLimit()` — mute-quota-warnings).
 * La preuve de bout en bout contre le VRAI CP (JWT réellement émis par `salonos-admin`,
 * réellement pull, réellement lu) est faite séparément, en direct, hors Jest — même
 * discipline que Delta 8 (Prompt 4).
 */
import * as crypto from 'crypto';
import * as jwt from 'jsonwebtoken';
import { bootApp, stopApp, startTestDb, stopTestDb, TestDb, TestApp } from './utils/test-app';
import { EntitlementsService } from '../src/common/entitlements/entitlements.service';
import { FlagsService } from '../src/common/entitlements/flags.service';
import { runWithTenant, TenantContext } from '../src/common/tenant/tenant-context';

function baseCtx(salonId: string, flags?: Record<string, boolean>): TenantContext {
  return { tenantId: salonId, locationId: '', locationIds: [], role: 'owner', plan: 'starter', features: {}, limits: {}, flags };
}

describe('feature flags — Delta 3 (Sprint 3 v2 Prompt 7)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let entitlements: EntitlementsService;
  let flagsService: FlagsService;

  beforeAll(async () => {
    testDb = await startTestDb('feature_flags_dp');
    testApp = await bootApp();
    entitlements = testApp.app.get(EntitlementsService);
    flagsService = testApp.app.get(FlagsService);
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  // ─── 1. Le champ existe et se fusionne correctement ────────────────────────────────

  it('verify() : payload.flags absent (CP antérieur à ce prompt) -> resolved.flags = {} (jamais undefined)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    process.env.CP_PUBLIC_KEY = publicKey;
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign({ tenantId: 'flags-no-field-tenant', plan: 'starter', features: {}, limits: {}, status: 'active', iat: now, exp: now + 3600 }, privateKey, { algorithm: 'RS256' });

    const resolved = entitlements.verify(token, 'flags-no-field-tenant');
    expect(resolved.flags).toEqual({});
    delete process.env.CP_PUBLIC_KEY;
  });

  it('verify() : payload.flags présent -> fusionné tel quel dans resolved.flags', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    process.env.CP_PUBLIC_KEY = publicKey;
    const now = Math.floor(Date.now() / 1000);
    const token = jwt.sign(
      { tenantId: 'flags-present-tenant', plan: 'pro', features: {}, limits: {}, status: 'active', flags: { 'mute-quota-warnings': true, 'some-other-flag': false }, iat: now, exp: now + 3600 },
      privateKey,
      { algorithm: 'RS256' },
    );

    const resolved = entitlements.verify(token, 'flags-present-tenant');
    expect(resolved.flags).toEqual({ 'mute-quota-warnings': true, 'some-other-flag': false });
    delete process.env.CP_PUBLIC_KEY;
  });

  it('fallback (pas de CP configuré) -> flags = {} — jamais un flag hérité sans admin explicite', async () => {
    const resolved = await entitlements.resolve('fallback-flags-tenant');
    expect(resolved.flags).toEqual({});
  });

  // ─── 2. FlagsService — le "point de lecture" nommé par le SKILL ────────────────────

  it('FlagsService.isEnabled() : lit tenantStorage, true seulement si explicitement true', () => {
    runWithTenant(baseCtx('t1', { 'mute-quota-warnings': true }), () => {
      expect(flagsService.isEnabled('mute-quota-warnings')).toBe(true);
      expect(flagsService.isEnabled('unknown-flag')).toBe(false);
    });
    runWithTenant(baseCtx('t2', { 'mute-quota-warnings': false }), () => {
      expect(flagsService.isEnabled('mute-quota-warnings')).toBe(false);
    });
    runWithTenant(baseCtx('t3'), () => {
      expect(flagsService.isEnabled('mute-quota-warnings')).toBe(false); // flags absent -> false, jamais throw
    });
  });

  it('FlagsService.isEnabled() hors tout contexte -> false, jamais throw (job cron, script)', () => {
    expect(flagsService.isEnabled('mute-quota-warnings')).toBe(false);
  });

  // ─── 3. checkSoftLimit — LE comportement réel qui change selon le flag ─────────────

  async function notificationCount(salonId: string): Promise<number> {
    return testDb.db.collection('notifications').countDocuments({ salonId, type: 'entitlements.quota_warning' });
  }

  it('checkSoftLimit : flag OFF (comportement inchangé) -> notification de quota dispatchée à 100%', async () => {
    const salonId = 'soft-limit-flag-off';
    await runWithTenant(baseCtx(salonId, { 'mute-quota-warnings': false }), () => entitlements.checkSoftLimit(salonId, 'appointmentsMonth', 100, 100));
    expect(await notificationCount(salonId)).toBe(1);
  });

  it('checkSoftLimit : flag ON -> AUCUNE notification, même à 100% (comportement réel qui change selon le flag CP)', async () => {
    const salonId = 'soft-limit-flag-on';
    await runWithTenant(baseCtx(salonId, { 'mute-quota-warnings': true }), () => entitlements.checkSoftLimit(salonId, 'appointmentsMonth', 100, 100));
    expect(await notificationCount(salonId)).toBe(0);
  });

  it('checkSoftLimit : sans flags du tout (TenantContext.flags undefined) -> comportement historique inchangé, notification dispatchée', async () => {
    const salonId = 'soft-limit-no-flags-field';
    await runWithTenant(baseCtx(salonId), () => entitlements.checkSoftLimit(salonId, 'appointmentsMonth', 100, 100));
    expect(await notificationCount(salonId)).toBe(1);
  });
});
