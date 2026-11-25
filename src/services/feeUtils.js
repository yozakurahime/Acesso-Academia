/**
 * Identifica o canal real do pagamento ('point' | 'online' | 'checkout' | 'subscription').
 */
export function resolvePaymentChannel(payment = {}) {
  const ext = String(payment?.external_id || '').toLowerCase();
  const notes = String(payment?.notes || '').toLowerCase();
  if (payment?.checkout_ref || notes.includes('pagamento online (mercado pago)') || notes.includes('checkout')) {
    return 'checkout';
  }
  if (notes.includes('assinatura mercado pago') || ext.includes('preapproval')) {
    return 'subscription';
  }
  if (ext.startsWith('point:') || ext.startsWith('mp_point') || ext.startsWith('stone:')) {
    return 'point';
  }
  if (ext.startsWith('mercadopago:') || ext.startsWith('mp_')) {
    return 'online';
  }
  return 'point';
}

/**
 * Calcula taxa (%) e valor líquido em centavos conforme método de pagamento e canal.
 */
export function getFeePercentForMethod(method, settings = {}, { channel = 'point' } = {}) {
  const m = String(method || '').trim().toLowerCase();
  const c = String(channel || 'point').trim().toLowerCase();
  const toPct = (val, fallback) => {
    const num = Number(String(val ?? fallback).replace(',', '.'));
    return Number.isFinite(num) && num >= 0 ? num : Number(fallback);
  };
  if (m === 'debit' || m === 'debit_card') {
    if (c === 'checkout' || c === 'online') {
      return toPct(settings.fee_checkout_debit_pct, 3.99);
    }
    return toPct(settings.fee_point_debit_pct, 0.74);
  }
  if (m === 'credit' || m === 'credit_card') {
    if (c === 'subscription') {
      return toPct(settings.fee_subscription_credit_pct ?? settings.fee_online_credit_pct, 4.98);
    }
    if (c === 'checkout') {
      return toPct(settings.fee_checkout_credit_pct ?? settings.fee_online_credit_pct, 4.98);
    }
    if (c === 'online') {
      return toPct(settings.fee_online_credit_pct, 4.98);
    }
    return toPct(settings.fee_point_credit_pct, 0.74);
  }
  if (m === 'pix' || m === 'qr') {
    if (c === 'checkout') {
      return toPct(settings.fee_checkout_pix_pct ?? settings.fee_online_pix_pct, 0.99);
    }
    if (c === 'online') {
      return toPct(settings.fee_online_pix_pct, 0.99);
    }
    return toPct(settings.fee_point_pix_pct, 0);
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
