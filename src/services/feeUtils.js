/**
 * Calcula taxa (%) e valor líquido em centavos conforme método de pagamento e canal (point/online).
 */
export function getFeePercentForMethod(method, settings = {}, { channel = 'point' } = {}) {
  const m = String(method || '').trim().toLowerCase();
  const toPct = (val, fallback) => {
    const num = Number(String(val ?? fallback).replace(',', '.'));
    return Number.isFinite(num) && num >= 0 ? num : Number(fallback);
  };
  if (m === 'debit' || m === 'debit_card') {
    return toPct(settings.fee_point_debit_pct, 0.74);
  }
  if (m === 'credit' || m === 'credit_card') {
    return channel === 'online'
      ? toPct(settings.fee_online_credit_pct, 4.98)
      : toPct(settings.fee_point_credit_pct, 0.74);
  }
  if (m === 'pix' || m === 'qr') {
    return channel === 'online'
      ? toPct(settings.fee_online_pix_pct, 0.99)
      : toPct(settings.fee_point_pix_pct, 0);
  }
  return 0;
}

export function calculatePaymentFee(amountCents, method, settings = {}, { channel = 'point' } = {}) {
  const gross = Math.max(0, Math.round(Number(amountCents || 0)));
  const feePct = getFeePercentForMethod(method, settings, { channel });
  const feeCents = feePct > 0 ? Math.round((gross * feePct) / 100) : 0;
  return {
    gross_cents: gross,
    fee_pct: feePct,
    fee_cents: feeCents,
    net_cents: Math.max(0, gross - feeCents),
  };
}
