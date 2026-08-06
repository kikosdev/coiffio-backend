import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import nodemailer, { Transporter } from 'nodemailer';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

const REQUIRED_SMTP_VARS = ['SMTP_HOST', 'SMTP_PORT', 'SMTP_USER', 'SMTP_PASS'] as const;

function requireSmtpEnv(env: NodeJS.ProcessEnv): { host: string; port: number; user: string; pass: string; from: string } {
  const missing = REQUIRED_SMTP_VARS.filter((key) => !env[key] || env[key]!.trim() === '');
  if (missing.length > 0) {
    throw new Error(`[EmailService] Missing required env var(s): ${missing.join(', ')}. See .env.example.`);
  }
  const port = Number(env.SMTP_PORT);
  if (!Number.isFinite(port)) {
    throw new Error(`[EmailService] SMTP_PORT is not a valid number: "${env.SMTP_PORT}".`);
  }
  return { host: env.SMTP_HOST!, port, user: env.SMTP_USER!, pass: env.SMTP_PASS!, from: env.SMTP_FROM?.trim() || env.SMTP_USER! };
}

/**
 * [Sprint 4 Prompt 2] Transport Nodemailer/SMTP, lu depuis .env — jamais de credentials en
 * dur. Conçu pour changer de transport (Resend/SendGrid/...) plus tard SANS toucher le code
 * appelant : `sendEmail({to,subject,html})` est le seul contrat public, `nodemailer` est un
 * détail d'implémentation privé de cette classe.
 *
 * `validateEnv` (le constructeur) échoue au boot si SMTP_* manque — même discipline que les
 * autres secrets du projet (fail-fast et clair, jamais un crash sans contexte au premier
 * envoi réel). `onModuleInit` vérifie la connexion (`transporter.verify()`) et LOGUE le
 * résultat — informatif, pas fatal : un souci réseau passager au boot ne doit pas empêcher
 * l'API de démarrer, seulement être visible immédiatement dans les logs.
 *
 * `NODE_ENV==='test'` : ni `verify()` ni `sendMail()` ne touchent le réseau — Jest boote
 * l'AppModule complet dans chaque fichier de spec (`bootApp()`), un envoi réel à chaque run
 * spammerait la vraie boîte Gmail configurée en `.env`. Les tests qui veulent vérifier UN
 * envoi précis mockent `EmailService.prototype.sendEmail` explicitement.
 */
@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: Transporter;
  private readonly from: string;

  constructor() {
    const { host, port, user, pass, from } = requireSmtpEnv(process.env);
    this.from = from;
    this.transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: { user, pass },
    });
  }

  async onModuleInit(): Promise<void> {
    if (process.env.NODE_ENV === 'test') return;
    try {
      await this.transporter.verify();
      this.logger.log(`SMTP connection verified (from=${this.from}).`);
    } catch (err) {
      this.logger.error(`SMTP verify() failed — emails will not send until this is fixed: ${(err as Error).message}`);
    }
  }

  async sendEmail(input: SendEmailInput): Promise<void> {
    if (process.env.NODE_ENV === 'test') {
      this.logger.debug(`[test mode] Skipped real send: to=${input.to} subject="${input.subject}"`);
      return;
    }
    await this.transporter.sendMail({ from: this.from, to: input.to, subject: input.subject, html: input.html });
    this.logger.log(`Email sent: to=${input.to} subject="${input.subject}"`);
  }
}
