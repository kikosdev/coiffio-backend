/**
 * Taux sociaux / fiscaux par pays.
 * ⚠️ Ne JAMAIS coder ces taux en dur dans les vues — toujours passer par cette config.
 * Les valeurs ci-dessous sont indicatives et doivent être validées avec un expert-comptable.
 */
export interface PayrollRates {
  /** Cotisation sociale salariale (part employé) — fraction du brut. */
  social: number;
  /** Retenue à la source / impôt — fraction du (brut − social). */
  tax: number;
  /** Code ISO du pays, pour information. */
  country: string;
  currency: string;
}

export const PAYROLL_RATES: Record<string, PayrollRates> = {
  // Tunisie — CNSS part salariale ≈ 9.18 %, retenue à la source simplifiée 6 %.
  TN: { social: 0.0918, tax: 0.06, country: 'TN', currency: 'TND' },
  // France — exemple simplifié (cotisations salariales ≈ 22 %, PAS 6 %).
  FR: { social: 0.22, tax: 0.06, country: 'FR', currency: 'EUR' },
};

export const DEFAULT_PAYROLL_COUNTRY = process.env.PAYROLL_COUNTRY || 'TN';

export function getPayrollRates(country = DEFAULT_PAYROLL_COUNTRY): PayrollRates {
  return PAYROLL_RATES[country] || PAYROLL_RATES.TN;
}

export interface Payslip {
  base: number;
  commission: number;
  tips: number;
  gross: number;
  social: number;
  tax: number;
  net: number;
}

/**
 * Calcule une fiche de paie pour un membre sur une période donnée (facteur `mult`).
 * Centralise la logique partagée avec le front (slipFor).
 */
export function computeSlip(
  member: { base: number; commission: number; tip: number },
  mult: number,
  country = DEFAULT_PAYROLL_COUNTRY,
): Payslip {
  const rates = getPayrollRates(country);
  const base = Math.round(member.base * mult);
  const commission = Math.round(member.commission * mult);
  const tips = Math.round(member.tip * mult);
  const gross = base + commission + tips;
  const social = Math.round(gross * rates.social);
  const tax = Math.round((gross - social) * rates.tax);
  const net = gross - social - tax;
  return { base, commission, tips, gross, social, tax, net };
}
