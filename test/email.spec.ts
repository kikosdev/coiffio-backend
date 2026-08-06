/**
 * Sprint 4 Prompt 2 — Transport email (Nodemailer/SMTP) + email de bienvenue au
 * provisioning + reset password fonctionnel. `EmailService.sendEmail()` est un no-op réseau
 * sous `NODE_ENV==='test'` (voir sa docstring) — ces tests espionnent
 * `EmailService.prototype.sendEmail` pour vérifier CE QUI serait envoyé (destinataire,
 * sujet, lien avec token) sans jamais toucher le vrai SMTP Gmail. La preuve d'un envoi RÉEL
 * (boîte Gmail) est faite séparément, en direct, hors Jest — même discipline que Delta 8/3.
 */
import { ObjectId } from 'mongodb';
import {
  startTestDb,
  stopTestDb,
  bootApp,
  stopApp,
  fetchJson,
  jsonHeaders,
  internalHeaders,
  seedStaff,
  seedSalon,
  TestDb,
  TestApp,
} from './utils/test-app';
import { EmailService, SendEmailInput } from '../src/email/email.service';

describe('EmailService — env validation (pure, no Nest boot)', () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('missing SMTP_HOST/PORT/USER/PASS → throws listing every missing var', () => {
    delete process.env.SMTP_HOST;
    delete process.env.SMTP_PORT;
    delete process.env.SMTP_USER;
    delete process.env.SMTP_PASS;
    expect(() => new EmailService()).toThrow(/SMTP_HOST.*SMTP_PORT.*SMTP_USER.*SMTP_PASS/);
  });

  it('SMTP_PORT not a number → throws explicitly', () => {
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = 'not-a-number';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    expect(() => new EmailService()).toThrow(/SMTP_PORT/);
  });

  it('all SMTP_* present → constructs without throwing', () => {
    process.env.SMTP_HOST = 'smtp.example.test';
    process.env.SMTP_PORT = '587';
    process.env.SMTP_USER = 'user';
    process.env.SMTP_PASS = 'pass';
    expect(() => new EmailService()).not.toThrow();
  });
});

describe('email templates (pure functions)', () => {
  it('welcome template contains the setup link and NEVER a plaintext password', () => {
    const { welcomeEmailHtml } = require('../src/email/templates');
    const setupUrl = 'http://x/reset-password?token=abc123';
    const html = welcomeEmailHtml({ ownerName: 'Jane Doe', salonName: 'Salon Test', setupUrl });
    expect(html).toContain(setupUrl);
    expect(html).toContain('Jane Doe');
    expect(html).toContain('Salon Test');
    // The function's own signature has no password parameter to leak — this just confirms
    // the rendered output, with the URL stripped out, carries no credential-shaped value.
    expect(html.split(setupUrl).join('')).not.toMatch(/password.{0,20}[:=]\s*\S/i);
  });

  it('reset template contains the reset link', () => {
    const { passwordResetEmailHtml } = require('../src/email/templates');
    const html = passwordResetEmailHtml({ resetUrl: 'http://x/reset-password?token=def456' });
    expect(html).toContain('http://x/reset-password?token=def456');
  });

  it('escapes HTML in interpolated fields (XSS hygiene) — a malicious owner name cannot inject markup', () => {
    const { welcomeEmailHtml } = require('../src/email/templates');
    const html = welcomeEmailHtml({ ownerName: '<script>evil()</script>', salonName: 'S', setupUrl: 'http://x' });
    expect(html).not.toContain('<script>evil()</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('password-reset request — real email dispatch (Sprint 4 Prompt 2)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let sendEmailSpy: jest.SpyInstance;

  beforeAll(async () => {
    testDb = await startTestDb('email_reset');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  beforeEach(() => {
    sendEmailSpy = jest.spyOn(EmailService.prototype, 'sendEmail').mockResolvedValue(undefined);
  });

  afterEach(() => {
    sendEmailSpy.mockRestore();
  });

  it('known email identifier → sendEmail called once with the reset link, subject in French, HTML body', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'email-reset-salon' });
    await seedStaff(testDb.db, {
      tenantId: salon.tenantId,
      role: 'owner',
      locationIds: [salon.locations[0].id],
      defaultLocationId: salon.locations[0].id,
      identifier: 'reset-target@email-test.local',
    });

    const res = await fetchJson(`${testApp.baseUrl}/auth/password-reset/request`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: 'reset-target@email-test.local' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ sent: true });

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0] as SendEmailInput;
    expect(call.to).toBe('reset-target@email-test.local');
    expect(call.subject).toMatch(/mot de passe/i);
    expect(call.html).toMatch(/\/reset-password\?token=[\w.-]+/);
  });

  it('unknown identifier → sendEmail NOT called, still returns {sent:true} (no account-existence leak)', async () => {
    const res = await fetchJson(`${testApp.baseUrl}/auth/password-reset/request`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: 'nobody-here@email-test.local' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ sent: true });
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('phone identifier → no email channel, sendEmail NOT called, still {sent:true}', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'email-reset-phone-salon' });
    await seedStaff(testDb.db, {
      tenantId: salon.tenantId,
      role: 'owner',
      locationIds: [salon.locations[0].id],
      defaultLocationId: salon.locations[0].id,
      identifier: '+21629112233',
    });
    // seedStaff always sets identifierType:'email' — flip it directly to simulate a real
    // phone-identifier account without adding a phone-aware seed variant just for this test.
    await testDb.db.collection('users').updateOne({ identifier: '+21629112233' }, { $set: { identifierType: 'phone' } });

    const res = await fetchJson(`${testApp.baseUrl}/auth/password-reset/request`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: '+21629112233' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ sent: true });
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('SMTP send failure → still returns {sent:true} (logged, never surfaced to the client)', async () => {
    sendEmailSpy.mockRejectedValueOnce(new Error('SMTP connection refused'));
    const salon = await seedSalon(testDb.db, { slug: 'email-reset-fail-salon' });
    await seedStaff(testDb.db, {
      tenantId: salon.tenantId,
      role: 'owner',
      locationIds: [salon.locations[0].id],
      defaultLocationId: salon.locations[0].id,
      identifier: 'reset-fail@email-test.local',
    });

    const res = await fetchJson(`${testApp.baseUrl}/auth/password-reset/request`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: 'reset-fail@email-test.local' }),
    });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ sent: true });
  });

  it('end-to-end: request → confirm with the emailed token → login with the new password', async () => {
    const salon = await seedSalon(testDb.db, { slug: 'email-reset-e2e-salon' });
    await seedStaff(testDb.db, {
      tenantId: salon.tenantId,
      role: 'owner',
      locationIds: [salon.locations[0].id],
      defaultLocationId: salon.locations[0].id,
      identifier: 'reset-e2e@email-test.local',
    });

    await fetchJson(`${testApp.baseUrl}/auth/password-reset/request`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: 'reset-e2e@email-test.local' }),
    });
    const html = (sendEmailSpy.mock.calls[0][0] as SendEmailInput).html;
    const token = html.match(/token=([\w.-]+)/)![1];

    const confirmRes = await fetchJson(`${testApp.baseUrl}/auth/password-reset/confirm`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ token, password: 'brand-new-password-1' }),
    });
    expect(confirmRes.status).toBe(201);
    expect(confirmRes.body.data).toEqual({ reset: true });

    const loginRes = await fetchJson(`${testApp.baseUrl}/auth/login`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ identifier: 'reset-e2e@email-test.local', password: 'brand-new-password-1' }),
    });
    expect(loginRes.status).toBe(201);
    expect(loginRes.body.data.token).toBeTruthy();
  });
});

describe('welcome email on provisioning (Sprint 4 Prompt 2)', () => {
  let testDb: TestDb;
  let testApp: TestApp;
  let sendEmailSpy: jest.SpyInstance;

  beforeAll(async () => {
    testDb = await startTestDb('email_welcome');
    testApp = await bootApp();
  });

  afterAll(async () => {
    await stopApp(testApp);
    await stopTestDb(testDb);
  });

  beforeEach(() => {
    sendEmailSpy = jest.spyOn(EmailService.prototype, 'sendEmail').mockResolvedValue(undefined);
  });

  afterEach(() => {
    sendEmailSpy.mockRestore();
  });

  async function internalPost(path: string, payload: unknown) {
    const bodyStr = JSON.stringify(payload);
    return fetchJson(`${testApp.baseUrl}${path}`, { method: 'POST', headers: internalHeaders(bodyStr), body: bodyStr });
  }

  it('no explicit owner password (the nominal CP case) → welcome email sent with a setup link, salon/owner name in the subject line context', async () => {
    const tenantId = new ObjectId().toString();
    const res = await internalPost('/internal/tenants', {
      tenantId,
      slug: 'welcome-email-suite',
      name: 'Welcome Email Suite',
      timezone: 'Africa/Tunis',
      currency: 'TND',
      owner: { name: 'New Owner', email: 'new-owner@welcome-test.local', phone: '+21620000099' },
    });
    expect([200, 201]).toContain(res.status);

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);
    const call = sendEmailSpy.mock.calls[0][0] as SendEmailInput;
    expect(call.to).toBe('new-owner@welcome-test.local');
    expect(call.subject).toMatch(/bienvenue/i);
    expect(call.html).toContain('New Owner');
    expect(call.html).toContain('Welcome Email Suite');
    expect(call.html).toMatch(/\/reset-password\?token=[\w.-]+/);
  });

  it('explicit owner password provided → NO welcome email (the owner already knows their password)', async () => {
    const tenantId = new ObjectId().toString();
    const res = await internalPost('/internal/tenants', {
      tenantId,
      slug: 'no-welcome-email-suite',
      name: 'No Welcome Suite',
      timezone: 'Africa/Tunis',
      currency: 'TND',
      owner: { name: 'Known Password Owner', email: 'known-pw@welcome-test.local', phone: '+21620000098', password: 'already-known-pw-1' },
    });
    expect([200, 201]).toContain(res.status);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });

  it('email send failure does NOT roll back or fail provisioning — the tenant is still created', async () => {
    sendEmailSpy.mockRejectedValueOnce(new Error('SMTP down'));
    const tenantId = new ObjectId().toString();
    const res = await internalPost('/internal/tenants', {
      tenantId,
      slug: 'welcome-fail-suite',
      name: 'Welcome Fail Suite',
      timezone: 'Africa/Tunis',
      currency: 'TND',
      owner: { name: 'Resilient Owner', email: 'resilient@welcome-test.local', phone: '+21620000097' },
    });
    expect([200, 201]).toContain(res.status);
    expect(res.body.data).toMatchObject({ tenantId, slug: 'welcome-fail-suite' });

    const salon = await testDb.db.collection('salons').findOne({ _id: new ObjectId(tenantId) });
    expect(salon).toBeTruthy();
    const owner = await testDb.db.collection('staffs').findOne({ salonId: tenantId, role: 'owner' });
    expect(owner).toBeTruthy();
  });

  it('replaying the same tenantId (idempotent retry) does NOT re-send the welcome email', async () => {
    const tenantId = new ObjectId().toString();
    const dto = {
      tenantId,
      slug: 'welcome-idempotent-suite',
      name: 'Welcome Idempotent Suite',
      timezone: 'Africa/Tunis',
      currency: 'TND',
      owner: { name: 'Idempotent Owner', email: 'idempotent@welcome-test.local', phone: '+21620000096' },
    };
    await internalPost('/internal/tenants', dto);
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);

    sendEmailSpy.mockClear();
    const replay = await internalPost('/internal/tenants', dto);
    expect([200, 201]).toContain(replay.status);
    expect(sendEmailSpy).not.toHaveBeenCalled();
  });
});
