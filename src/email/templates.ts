/** HTML basique (Sprint 4 Prompt 2) — améliorable après. Jamais de mot de passe en clair,
 *  toujours un lien vers `/reset-password?token=...` (même page pour bienvenue et reset). */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function layout(bodyHtml: string): string {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#222;">
    <h2 style="margin-bottom:8px;">SalonOS</h2>
    ${bodyHtml}
  </div>`;
}

function linkButton(url: string, label: string): string {
  return `<p style="margin:24px 0;">
    <a href="${url}" style="background:#111;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;display:inline-block;">${label}</a>
  </p>
  <p style="font-size:12px;color:#888;word-break:break-all;">${url}</p>`;
}

export function welcomeEmailHtml(params: { ownerName: string; salonName: string; setupUrl: string }): string {
  return layout(`
    <p>Bienvenue sur SalonOS. Votre salon <strong>${escapeHtml(params.salonName)}</strong> est prêt, ${escapeHtml(params.ownerName)}.</p>
    <p>Cliquez pour définir votre mot de passe :</p>
    ${linkButton(params.setupUrl, 'Définir mon mot de passe')}
    <p style="font-size:12px;color:#888;">Ce lien expire dans 24 heures.</p>
  `);
}

export function passwordResetEmailHtml(params: { resetUrl: string }): string {
  return layout(`
    <p>Une réinitialisation de mot de passe a été demandée pour ce compte.</p>
    <p>Réinitialisez votre mot de passe :</p>
    ${linkButton(params.resetUrl, 'Réinitialiser mon mot de passe')}
    <p style="font-size:12px;color:#888;">Ce lien expire dans 1 heure. Si vous n'êtes pas à l'origine de cette demande, ignorez cet email.</p>
  `);
}
