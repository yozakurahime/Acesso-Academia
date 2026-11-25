import crypto from 'node:crypto';
import { normalizeBrPhone } from './whatsappService.js';
import { calculatePaymentFee } from './feeUtils.js';

function digitsOnly(str) {
  return String(str || '').replace(/\D/g, '');
}

const SUB_CYCLE_MAP = {
  WEEKLY: { frequency: 7, frequency_type: 'days' },
  BIWEEKLY: { frequency: 15, frequency_type: 'days' },
  MONTHLY: { frequency: 1, frequency_type: 'months' },
  BIMONTHLY: { frequency: 2, frequency_type: 'months' },
  QUARTERLY: { frequency: 3, frequency_type: 'months' },
  SEMIANNUALLY: { frequency: 6, frequency_type: 'months' },
  YEARLY: { frequency: 12, frequency_type: 'months' },
};

function mapDurationToCycle(durationDays) {
  const days = Number(durationDays || 30);
  if (days <= 7) return 'WEEKLY';
  if (days <= 15) return 'BIWEEKLY';
  if (days <= 45) return 'MONTHLY';
  if (days <= 75) return 'BIMONTHLY';
  if (days <= 120) return 'QUARTERLY';
  if (days <= 210) return 'SEMIANNUALLY';
  return 'YEARLY';
}

function mapPreapprovalStatus(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'authorized' || s === 'active') return 'active';
  if (s === 'paused') return 'paused';
  if (s === 'cancelled' || s === 'canceled') return 'canceled';
  return 'pending';
}

export class GatewayService {
  constructor(store, accessService, { whatsappService = null, fetchFn = globalThis.fetch } = {}) {
    this.store = store;
    this.accessService = accessService;
    this.whatsappService = whatsappService;
    this.fetch = fetchFn;
    this.checkoutRequests = new Map();
    this.pixRequests = new Map();
    this.settleLocks = new Map();
  }

  /**
   * Executes safe read-only Mercado Pago requests with short exponential backoff
   * on transient HTTP statuses (429/502/503/504) or network errors.
   */
  async mpFetchWithRetry(url, options = {}, { retries = 2, baseDelayMs = 200 } = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') {
      return this.fetch(url, options);
    }
    const transientStatuses = new Set([429, 502, 503, 504]);
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const res = await this.fetch(url, options);
        if (!transientStatuses.has(res.status) || attempt === retries) {
          return res;
        }
      } catch (err) {
        lastError = err;
        if (options.signal?.aborted || attempt === retries) {
          throw err;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * (attempt + 1)));
    }
    throw lastError;
  }

  async safeJson(res) {
    if (typeof res?.text === 'function') {
      const text = await res.text();
      if (!text) return {};
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    }
    if (typeof res?.json === 'function') {
      return res.json().catch(() => null);
    }
    return null;
  }

  getMpAuth(settings = this.store.getSettings()) {
    const token = String(settings.mp_access_token || '').trim();
    if (!token) {
      const err = new Error('Access Token do Mercado Pago não configurado em Configurações.');
      err.statusCode = 400;
      throw err;
    }
    if (/^APP_USR-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
      const err = new Error('O valor salvo no Mercado Pago é uma Public Key (Chave Pública). Cole o Access Token de Produção em Configurações → Pagamentos Online.');
      err.statusCode = 400;
      throw err;
    }
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  getPointAuth(settings = this.store.getSettings()) {
    if (process.env.MP_POINT_TEST_MODE === 'true') {
      const testToken = process.env.MP_POINT_TEST_ACCESS_TOKEN;
      if (!testToken) throw new Error('Informe MP_POINT_TEST_ACCESS_TOKEN para testar a Point.');
      return this.getMpAuth({ mp_access_token: testToken });
    }
    return this.getMpAuth({ mp_access_token: settings.mp_point_access_token || settings.mp_access_token || process.env.MP_POINT_ACCESS_TOKEN });
  }

  getPointTerminalId(terminalId, settings = this.store.getSettings()) {
    return String(terminalId || settings.mp_point_terminal_id || process.env.MP_POINT_TERMINAL_ID || '').trim();
  }

  listCharges(limit = 20) {
    return this.store.all(
      `SELECT gc.*, m.name AS member_name, p.name AS plan_name
       FROM gateway_charges gc
       JOIN members m ON m.id = gc.member_id
       LEFT JOIN plans p ON p.id = gc.plan_id
       ORDER BY CASE WHEN gc.status = 'pending' THEN 0 ELSE 1 END, gc.id DESC
       LIMIT ?`,
      [Number(limit)],
    );
  }

  getOnlineCashSummary(limit = 20) {
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const monthPrefix = today.slice(0, 7);
    const settings = this.store.getSettings();
    const paidRows = this.store.all(
      `SELECT gc.amount_cents, gc.checkout_ref, COALESCE(gc.paid_at, gc.created_at) AS paid_at,
              p.method AS paid_method
       FROM gateway_charges gc
       LEFT JOIN payments p ON p.id = gc.payment_id
       WHERE gc.status = 'paid'`,
    );
    const agg = {
      today_cents: 0,
      today_fee_cents: 0,
      today_net_cents: 0,
      today_count: 0,
      month_cents: 0,
      month_fee_cents: 0,
      month_net_cents: 0,
      month_count: 0,
      total_cents: 0,
      total_fee_cents: 0,
      total_net_cents: 0,
      total_count: 0,
      by_channel: {
        online_pix: { gross_cents: 0, fee_cents: 0, net_cents: 0, count: 0 },
        checkout: { gross_cents: 0, fee_cents: 0, net_cents: 0, count: 0 },
      },
    };
    for (const row of paidRows) {
      const channel = row.checkout_ref ? 'checkout' : 'online';
      const channelMethod = row.paid_method || (row.checkout_ref ? 'credit' : 'pix');
      const feeInfo = calculatePaymentFee(row.amount_cents, channelMethod, settings, { channel });
      const bucket = row.checkout_ref ? agg.by_channel.checkout : agg.by_channel.online_pix;
      bucket.gross_cents += feeInfo.gross_cents;
      bucket.fee_cents += feeInfo.fee_cents;
      bucket.net_cents += feeInfo.net_cents;
      bucket.count += 1;
      const paidDay = String(row.paid_at || '').slice(0, 10);
      const paidMonth = String(row.paid_at || '').slice(0, 7);
      agg.total_cents += feeInfo.gross_cents;
      agg.total_fee_cents += feeInfo.fee_cents;
      agg.total_net_cents += feeInfo.net_cents;
      agg.total_count += 1;
      if (paidDay === today) {
        agg.today_cents += feeInfo.gross_cents;
        agg.today_fee_cents += feeInfo.fee_cents;
        agg.today_net_cents += feeInfo.net_cents;
        agg.today_count += 1;
      }
      if (paidMonth === monthPrefix) {
        agg.month_cents += feeInfo.gross_cents;
        agg.month_fee_cents += feeInfo.fee_cents;
        agg.month_net_cents += feeInfo.net_cents;
        agg.month_count += 1;
      }
    }

    const items = this.store.all(
      `SELECT gc.id, gc.member_id, m.name AS member_name, p.name AS plan_name, gc.amount_cents,
              gc.checkout_ref, gc.batch_items_json, COALESCE(gc.paid_at, gc.created_at) AS paid_at,
              pay.method AS paid_method
       FROM gateway_charges gc
       JOIN members m ON m.id = gc.member_id
       LEFT JOIN plans p ON p.id = gc.plan_id
       LEFT JOIN payments pay ON pay.id = gc.payment_id
       WHERE gc.status = 'paid'
       ORDER BY COALESCE(gc.paid_at, gc.created_at) DESC, gc.id DESC
       LIMIT ?`,
      [Number(limit)],
    ).map((item) => {
      const channel = item.checkout_ref ? 'checkout' : 'online';
      const channelMethod = item.paid_method || (item.checkout_ref ? 'credit' : 'pix');
      const feeInfo = calculatePaymentFee(item.amount_cents, channelMethod, settings, { channel });
      return { ...item, channel, fee_cents: feeInfo.fee_cents, net_cents: feeInfo.net_cents, fee_pct: feeInfo.fee_pct };
    });
    return { ...agg, items };
  }

  _badRequest(message) {
    const err = new Error(message);
    err.statusCode = 400;
    return err;
  }

  resolveBillableMember(member, planId, amount) {
    if (!member || member.access_role !== 'student') throw this._badRequest('Selecione um aluno para cobrar.');
    const charge = this.store.get('SELECT id, amount FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due, id LIMIT 1', [member.id]);
    const plan = this.store.get('SELECT * FROM plans WHERE id = ?', [charge ? member.plan_id : Number(planId || member.plan_id)]);
    if (!plan) throw this._badRequest('Selecione um plano para cobrar.');
    const customCents = amount !== null && amount !== undefined && String(amount).trim() !== '' ? Number(amount) : NaN;
    const cents = Number.isSafeInteger(customCents) && customCents > 0
      ? customCents
      : (charge?.amount ?? Number(plan.price_cents));
    if (!Number.isSafeInteger(cents) || cents <= 0) throw this._badRequest('Valor da cobrança inválido.');
    return { plan, cents, charge };
  }

  async createPixCharge({ member_id, plan_id = null, amount_cents = null }) {
    const memberId = Number(member_id);
    if (this.pixRequests.has(memberId)) return this.pixRequests.get(memberId);
    const request = this._createPixChargeOnce({ member_id: memberId, plan_id, amount_cents });
    this.pixRequests.set(memberId, request);
    try {
      return await request;
    } finally {
      this.pixRequests.delete(memberId);
    }
  }

  async _createPixChargeOnce({ member_id, plan_id = null, amount_cents = null }) {
    const settings = this.store.getSettings();
    const member = this.store.get('SELECT * FROM members WHERE id = ?', [Number(member_id)]);
    if (!member) throw new Error('Aluno não encontrado.');

    const { plan, cents: finalAmount, charge } = this.resolveBillableMember(member, plan_id, amount_cents);

    if (charge?.id) {
      const existingPending = this.store.get(
        `SELECT gc.*, m.name AS member_name, p.name AS plan_name
         FROM gateway_charges gc
         JOIN members m ON m.id = gc.member_id
         LEFT JOIN plans p ON p.id = gc.plan_id
         WHERE gc.provider = 'mercadopago' AND gc.checkout_ref IS NULL AND gc.member_id = ? AND gc.membership_charge_id = ? AND gc.status = 'pending'
         ORDER BY gc.id DESC LIMIT 1`,
        [member.id, charge.id],
      );
      if (existingPending) return existingPending;
    }

    const description = `${settings.gym_name || 'Academia'} - ${plan?.name || 'Mensalidade'} (${member.name})`;
    const windowBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `mp_pix:${member.id}:${charge?.id || 'adhoc'}:${finalAmount}:${windowBucket}`;
    const created = await this.createMercadoPagoPix({ member, amountCents: finalAmount, description, settings, idempotencyKey });

    const res = this.store.run(
      `INSERT INTO gateway_charges (provider, external_id, member_id, plan_id, amount_cents, status, qr_code, qr_base64, payment_url, membership_charge_id)
       VALUES ('mercadopago', ?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      [
        String(created.externalId),
        member.id,
        plan?.id || null,
        finalAmount,
        created.qrCode || null,
        created.qrBase64 || null,
        created.paymentUrl || null,
        charge?.id ?? null,
      ],
    );

    return this.store.get(
      `SELECT gc.*, m.name AS member_name, p.name AS plan_name
       FROM gateway_charges gc
       JOIN members m ON m.id = gc.member_id
       LEFT JOIN plans p ON p.id = gc.plan_id
       WHERE gc.id = ?`,
      [res.lastInsertRowid],
    );
  }

  async createCheckoutCharge({ member_id, plan_id = null, amount_cents = null }) {
    const memberId = Number(member_id);
    if (!amount_cents && this.checkoutRequests.has(memberId)) return this.checkoutRequests.get(memberId);
    const request = this.openCheckoutCharge(memberId, plan_id, amount_cents);
    if (!amount_cents) this.checkoutRequests.set(memberId, request);
    try {
      return await request;
    } finally {
      if (!amount_cents) this.checkoutRequests.delete(memberId);
    }
  }

  async createWhatsAppCheckout(memberId) {
    const member = this.store.get('SELECT id, name, phone FROM members WHERE id = ?', [Number(memberId)]);
    const phone = normalizeBrPhone(member?.phone);
    if (!phone) throw new Error('Cadastre um telefone válido no perfil do aluno antes de compartilhar.');
    const charge = await this.createCheckoutCharge({ member_id: member.id });
    const amount = (charge.amount_cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
    const name = member.name.trim().split(/\s+/)[0];
    const gym = this.store.getSettings().gym_name || 'Academia Oxigênio';
    const message = `Olá, ${name}! Segue o link do Mercado Pago para pagar sua mensalidade de ${amount} na ${gym}: ${charge.payment_url}`;
    return { charge, whatsapp_url: `https://wa.me/${phone}?text=${encodeURIComponent(message)}` };
  }

  async openCheckoutCharge(memberId, planId, customAmountCents = null) {
    const settings = this.store.getSettings();
    const member = this.store.get('SELECT * FROM members WHERE id = ?', [memberId]);
    const { plan, cents: baseCents, charge } = this.resolveBillableMember(member, planId);
    const parsedCustom = Number(customAmountCents);
    const cents = Number.isSafeInteger(parsedCustom) && parsedCustom > 0 ? parsedCustom : baseCents;
    const existing = this.store.get(`SELECT * FROM gateway_charges WHERE member_id = ? AND plan_id = ? AND amount_cents = ?
      AND membership_charge_id IS ? AND checkout_ref IS NOT NULL AND status = 'pending'
      AND created_at > datetime('now', 'localtime', '-24 hours') ORDER BY id DESC LIMIT 1`,
    [memberId, plan.id, cents, charge?.id ?? null]);
    if (existing) return existing;

    const reference = 'ox_checkout_' + crypto.randomUUID();
    const title = `${settings.gym_name || 'Academia'} - ${plan.name}`.slice(0, 120);
    const now = Date.now();
    const notificationUrl = this.getMpNotificationUrl(settings);
    const response = await this.fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { ...this.getMpAuth(settings), 'X-Idempotency-Key': reference },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        items: [{ id: String(plan.id), title, quantity: 1, currency_id: 'BRL', unit_price: cents / 100 }],
        external_reference: reference,
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
        expires: true,
        expiration_date_from: new Date(now - 60000).toISOString(),
        expiration_date_to: new Date(now + 24 * 3600000).toISOString(),
      }),
    });
    const data = await this.safeJson(response);
    if (!response.ok || !data?.id || !data?.init_point) {
      throw new Error(data?.message || 'Não foi possível gerar o link de pagamento.');
    }
    const isTestToken = String(settings.mp_access_token || '').trim().startsWith('TEST-');
    const rawInitPoint = isTestToken && data.sandbox_init_point ? data.sandbox_init_point : data.init_point;
    const url = new URL(rawInitPoint);
    if (url.protocol !== 'https:' || !/(^|\.)mercadopago\.com(?:\.br)?$/i.test(url.hostname)) {
      throw new Error('O Mercado Pago retornou um endereço de checkout inválido.');
    }
    const { lastInsertRowid } = this.store.run(`INSERT INTO gateway_charges
      (provider, external_id, member_id, plan_id, amount_cents, payment_url, membership_charge_id, checkout_ref)
      VALUES ('mercadopago', ?, ?, ?, ?, ?, ?, ?)`, [String(data.id), memberId, plan.id, cents, url.href, charge?.id ?? null, reference]);
    return this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [lastInsertRowid]);
  }

  async createBatchPayment({ memberIds = [], mode = 'pix' } = {}) {
    const uniqueIds = [...new Set((memberIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
    if (!uniqueIds.length) throw new Error('Selecione ao menos um aluno para gerar o pagamento.');

    const settings = this.store.getSettings();
    const resolved = uniqueIds.map((id) => {
      const member = this.store.get('SELECT * FROM members WHERE id = ?', [id]);
      if (!member) throw new Error(`Aluno #${id} não encontrado.`);
      return { member, ...this.resolveBillableMember(member) };
    });

    const batchItems = resolved.map((r) => ({
      member_id: r.member.id,
      member_name: r.member.name,
      plan_id: r.plan?.id || null,
      plan_name: r.plan?.name || 'Mensalidade',
      amount_cents: r.cents,
      membership_charge_id: r.charge?.id ?? null,
    }));
    const totalCents = batchItems.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);

    if (batchItems.length === 1) {
      const singleCharge = mode === 'checkout'
        ? await this.createCheckoutCharge({ member_id: batchItems[0].member_id })
        : await this.createPixCharge({ member_id: batchItems[0].member_id });
      return { charge: singleCharge, items: batchItems, totalCents };
    }

    const firstMember = resolved[0].member;
    const namesPreview = batchItems.map((i) => i.member_name.split(' ')[0]).join(', ');
    if (mode === 'checkout') {
      const reference = 'ox_checkout_' + crypto.randomUUID();
      const now = Date.now();
      const notificationUrl = this.getMpNotificationUrl(settings);
      const response = await this.fetch('https://api.mercadopago.com/checkout/preferences', {
        method: 'POST',
        headers: { ...this.getMpAuth(settings), 'X-Idempotency-Key': reference },
        signal: AbortSignal.timeout(15000),
        body: JSON.stringify({
          items: batchItems.map((i) => ({
            id: String(i.plan_id || i.member_id),
            title: `${i.plan_name} - ${i.member_name}`.slice(0, 120),
            quantity: 1,
            currency_id: 'BRL',
            unit_price: i.amount_cents / 100,
          })),
          external_reference: reference,
          ...(notificationUrl ? { notification_url: notificationUrl } : {}),
          expires: true,
          expiration_date_from: new Date(now - 60000).toISOString(),
          expiration_date_to: new Date(now + 24 * 3600000).toISOString(),
        }),
      });
      const data = await this.safeJson(response);
      if (!response.ok || !data?.id || !data?.init_point) {
        throw new Error(data?.message || 'Não foi possível gerar o link de pagamento.');
      }
      const isTestToken = String(settings.mp_access_token || '').trim().startsWith('TEST-');
    const rawInitPoint = isTestToken && data.sandbox_init_point ? data.sandbox_init_point : data.init_point;
    const url = new URL(rawInitPoint);
      if (url.protocol !== 'https:' || !/(^|\.)mercadopago\.com(?:\.br)?$/i.test(url.hostname)) {
        throw new Error('O Mercado Pago retornou um endereço de checkout inválido.');
      }
      const { lastInsertRowid } = this.store.run(
        `INSERT INTO gateway_charges
          (provider, external_id, member_id, plan_id, amount_cents, payment_url, membership_charge_id, checkout_ref, batch_items_json)
         VALUES ('mercadopago', ?, ?, ?, ?, ?, NULL, ?, ?)`,
        [String(data.id), firstMember.id, batchItems[0].plan_id, totalCents, url.href, reference, JSON.stringify(batchItems)],
      );
      return {
        charge: this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [lastInsertRowid]),
        items: batchItems,
        totalCents,
      };
    }

    const description = `${settings.gym_name || 'Academia'} - Mensalidades (${namesPreview})`.slice(0, 120);
    const windowBucket = Math.floor(Date.now() / (5 * 60 * 1000));
    const idempotencyKey = `mp_pix_batch:${batchItems.map((i) => `${i.member_id}:${i.amount_cents}`).join(',')}:${windowBucket}`;
    const created = await this.createMercadoPagoPix({ member: firstMember, amountCents: totalCents, description, settings, idempotencyKey });
    const res = this.store.run(
      `INSERT INTO gateway_charges
        (provider, external_id, member_id, plan_id, amount_cents, status, qr_code, qr_base64, payment_url, membership_charge_id, batch_items_json)
       VALUES ('mercadopago', ?, ?, ?, ?, 'pending', ?, ?, ?, NULL, ?)`,
      [
        String(created.externalId),
        firstMember.id,
        batchItems[0].plan_id,
        totalCents,
        created.qrCode || null,
        created.qrBase64 || null,
        created.paymentUrl || null,
        JSON.stringify(batchItems),
      ],
    );
    return {
      charge: this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [res.lastInsertRowid]),
      items: batchItems,
      totalCents,
    };
  }

  getMpNotificationUrl(settings = this.store.getSettings()) {
    const base = String(settings?.portal_url || process.env.PORTAL_URL || 'https://sistema.academiaoxigenio.com')
      .trim()
      .replace(/\/+$/, '');
    if (!/^https:\/\//i.test(base)) return null;
    return `${base}/api/gateways/mp/webhook`;
  }

  async createMercadoPagoPix({ member, amountCents, description, settings, idempotencyKey = null }) {
    const headers = this.getMpAuth(settings);
    const parts = String(member.name || 'Aluno').trim().split(/\s+/);
    const firstName = parts[0] || 'Aluno';
    const lastName = parts.slice(1).join(' ') || 'Academia';
    const cpf = digitsOnly(member.document || member.guardian_cpf);

    const cleanEmail = String(member.email || '').trim();
    const validEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)
      ? cleanEmail
      : `aluno${member.id}@academiaoxigenio.com`;
    const payer = {
      email: validEmail,
      first_name: firstName,
      last_name: lastName,
    };
    if (cpf.length === 11) {
      payer.identification = { type: 'CPF', number: cpf };
    }

    const resolvedKey =
      idempotencyKey || `mp_pix:${member.id}:${amountCents}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;

    const notificationUrl = this.getMpNotificationUrl(settings);
    const response = await this.fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Idempotency-Key': resolvedKey,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        transaction_amount: Number((amountCents / 100).toFixed(2)),
        description: description.slice(0, 120),
        payment_method_id: 'pix',
        external_reference: String(member.id),
        ...(notificationUrl ? { notification_url: notificationUrl } : {}),
        payer,
      }),
    });

    const data = await this.safeJson(response);
    if (!response.ok || !data?.id) {
      throw new Error(data?.message || data?.cause?.[0]?.description || `Erro Mercado Pago (${response.status})`);
    }

    const txData = data?.point_of_interaction?.transaction_data || {};
    const base64 = txData.qr_code_base64 ? `data:image/png;base64,${txData.qr_code_base64}` : null;

    return {
      externalId: String(data.id),
      qrCode: txData.qr_code || null,
      qrBase64: base64,
      paymentUrl: txData.ticket_url || null,
    };
  }

  async checkChargeStatus(chargeId) {
    const charge = this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [Number(chargeId)]);
    if (!charge) throw new Error('Cobrança não encontrada.');
    if (charge.status === 'paid') {
      return { paid: true, charge };
    }

    const headers = this.getMpAuth();
    if (charge.checkout_ref) {
      const query = new URLSearchParams({ external_reference: charge.checkout_ref, status: 'approved' });
      const response = await this.mpFetchWithRetry(`https://api.mercadopago.com/v1/payments/search?${query}`, {
        headers, signal: AbortSignal.timeout(15000),
      });
      const data = await this.safeJson(response);
      if (!response.ok) throw new Error(data?.message || 'Não foi possível consultar o pagamento online.');
      const payment = data?.results?.find((entry) => entry.status === 'approved' && entry.external_reference === charge.checkout_ref);
      if (!payment) return { paid: false, charge };
      return { paid: true, ...await this.settleCheckoutPayment(charge, payment) };
    }
    const res = await this.mpFetchWithRetry(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(charge.external_id)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const data = await this.safeJson(res);
    if (!res.ok) throw new Error(data?.message || `Erro ao consultar Mercado Pago (${res.status})`);

    if (data?.status === 'approved') {
      if (Math.round(Number(data.transaction_amount) * 100) !== charge.amount_cents) {
        throw new Error('Valor aprovado pelo Mercado Pago difere da cobrança registrada.');
      }
      const settled = await this.settleCharge(charge);
      return { paid: true, ...settled };
    }
    return { paid: false, charge };
  }

  async settleCheckoutPayment(charge, payment) {
    if (!payment.id || payment.status !== 'approved' || payment.currency_id !== 'BRL' ||
        Math.round(Number(payment.transaction_amount) * 100) !== charge.amount_cents) {
      throw new Error('O pagamento aprovado não corresponde à cobrança online.');
    }
    const method = { credit_card: 'credit', debit_card: 'debit', prepaid_card: 'debit', ticket: 'boleto' }[payment.payment_type_id] ||
      (payment.payment_method_id === 'pix' ? 'pix' : 'other');
    return await this.settleCharge(charge, { paymentId: payment.id, method, notes: 'Pagamento online (Mercado Pago)' });
  }

  async settleCharge(charge, opts = {}) {
    const lockKey = Number(charge?.id);
    if (Number.isFinite(lockKey) && this.settleLocks.has(lockKey)) {
      return this.settleLocks.get(lockKey);
    }
    const task = this._settleChargeOnce(charge, opts);
    if (Number.isFinite(lockKey)) this.settleLocks.set(lockKey, task);
    try {
      return await task;
    } finally {
      if (Number.isFinite(lockKey)) this.settleLocks.delete(lockKey);
    }
  }

  async _settleChargeOnce(charge, { paymentId = charge.external_id, method = 'pix', notes = 'Pix automático (Mercado Pago)' } = {}) {
    const fresh = this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [charge.id]);
    if (!fresh || fresh.status === 'paid') {
      return { alreadyPaid: true, charge: fresh || charge };
    }

    let batchItems = null;
    if (fresh.batch_items_json) {
      try {
        const parsed = JSON.parse(fresh.batch_items_json);
        if (Array.isArray(parsed) && parsed.length > 0) batchItems = parsed;
      } catch {
        batchItems = null;
      }
    }

    if (batchItems) {
      const results = [];
      let firstPaymentId = null;
      for (const item of batchItems) {
        const res = await this.accessService.recordPayment(
          {
            member_id: item.member_id,
            plan_id: item.plan_id,
            amount_cents: item.amount_cents,
            method,
            external_id: `mercadopago:${paymentId}:m${item.member_id}`,
            charge_id: item.membership_charge_id,
            notes: batchItems.length > 1 ? `${notes} · Lote (${batchItems.length} pessoas)` : notes,
          },
          {
            reconcileOpenCharge: true,
            exactCharge: Boolean(item.membership_charge_id),
            separateOnlineCash: true,
            onRecorded: (recordedId) => {
              if (!firstPaymentId) firstPaymentId = recordedId;
            },
          },
        );
        results.push(res);
        if (this.whatsappService && !res.alreadyRecorded) {
          this.whatsappService.enqueuePaymentReceipt(res).catch(() => {});
        }
      }
      this.store.run(
        `UPDATE gateway_charges SET status = 'paid', payment_id = COALESCE(payment_id, ?), paid_at = COALESCE(paid_at, datetime('now', 'localtime')) WHERE id = ? AND status <> 'paid'`,
        [firstPaymentId, fresh.id],
      );
      return {
        alreadyPaid: results.every((r) => Boolean(r.alreadyRecorded)),
        charge: this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [fresh.id]),
        paymentResult: results[0],
        paymentResults: results,
      };
    }

    const paymentResult = await this.accessService.recordPayment(
      {
        member_id: fresh.member_id,
        plan_id: fresh.plan_id,
        amount_cents: fresh.amount_cents,
        method,
        external_id: `mercadopago:${paymentId}`,
        charge_id: fresh.membership_charge_id,
        notes,
      },
      { reconcileOpenCharge: true, exactCharge: Boolean(fresh.membership_charge_id), separateOnlineCash: true,
        onRecorded: (paymentId) => this.store.run(
          `UPDATE gateway_charges SET status = 'paid', payment_id = ?, paid_at = COALESCE(paid_at, datetime('now', 'localtime')) WHERE id = ? AND status <> 'paid'`,
          [paymentId, fresh.id],
        ) },
    );

    if (this.whatsappService && !paymentResult.alreadyRecorded) {
      this.whatsappService.enqueuePaymentReceipt(paymentResult).catch(() => {});
    }

    return {
      alreadyPaid: Boolean(paymentResult.alreadyRecorded),
      charge: this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [fresh.id]),
      paymentResult,
    };
  }

  // --- Assinaturas Recorrentes (Mercado Pago Preapproval) ---

  listSubscriptions(limit = 50) {
    return this.store.all(
      `SELECT s.*, m.name AS member_name, p.name AS plan_name
       FROM mp_subscriptions s
       JOIN members m ON m.id = s.member_id
       LEFT JOIN plans p ON p.id = s.plan_id
       ORDER BY CASE WHEN s.status IN ('active', 'pending') THEN 0 ELSE 1 END, s.id DESC
       LIMIT ?`,
      [Number(limit)],
    );
  }

  getSubscriptionById(id) {
    return this.store.get(
      `SELECT s.*, m.name AS member_name, p.name AS plan_name
       FROM mp_subscriptions s
       JOIN members m ON m.id = s.member_id
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.id = ?`,
      [Number(id)],
    );
  }

  async createMpSubscription({ member_id, plan_id = null, amount_cents = null, cycle = null, payer_email = null, card_token_id = null }) {
    const badReq = (msg) => {
      const err = new Error(msg);
      err.status = 400;
      return err;
    };
    const settings = this.store.getSettings();
    let headers;
    try {
      headers = this.getMpAuth(settings);
    } catch (err) {
      throw badReq(err.message);
    }

    const member = this.store.get('SELECT * FROM members WHERE id = ?', [Number(member_id)]);
    if (!member || member.access_role !== 'student') throw badReq('Selecione um aluno para cobrar.');

    const plan = plan_id
      ? this.store.get('SELECT * FROM plans WHERE id = ?', [Number(plan_id)])
      : member.plan_id
        ? this.store.get('SELECT * FROM plans WHERE id = ?', [Number(member.plan_id)])
        : null;

    const finalAmount = Number(amount_cents || plan?.price_cents || 0);
    if (!plan || !Number.isSafeInteger(finalAmount) || finalAmount <= 0) {
      throw badReq('Informe um valor válido para a assinatura.');
    }

    const cycleKey = String(cycle || mapDurationToCycle(plan?.duration_days)).toUpperCase();
    const cycleSpec = SUB_CYCLE_MAP[cycleKey];
    if (!cycleSpec) {
      throw badReq('Ciclo de recorrência inválido.');
    }

    const rawEmail = String(payer_email || member.email || '').trim();
    if (payer_email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      throw badReq('Informe um e-mail válido para assinatura no cartão.');
    }
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : `aluno${member.id}@academiaoxigenio.com`;

    if (!card_token_id) {
      const existingSub = this.store.get(
        `SELECT id FROM mp_subscriptions
         WHERE member_id = ? AND COALESCE(plan_id, 0) = ? AND amount_cents = ?
           AND frequency = ? AND frequency_type = ? AND status IN ('pending', 'active', 'authorized')
         ORDER BY id DESC LIMIT 1`,
        [member.id, plan?.id || 0, finalAmount, cycleSpec.frequency, cycleSpec.frequency_type],
      );
      if (existingSub) {
        return { ...this.getSubscriptionById(existingSub.id), reused: true };
      }
    }

    const portalBase = String(settings.portal_url || 'https://sistema.academiaoxigenio.com').replace(/\/+$/, '');
    const externalRef = `mp_sub:${member.id}:${crypto.randomUUID().slice(0, 8)}`;
    const reason = `${settings.gym_name || 'Academia Oxigênio'} - ${plan?.name || 'Mensalidade'} (${member.name})`.slice(0, 120);
    const idempotencyKey = `mp_sub:${member.id}:${plan.id}:${finalAmount}:${cycleKey}:${Math.floor(Date.now() / (5 * 60 * 1000))}`;

    const preapprovalBody = {
      reason,
      external_reference: externalRef,
      payer_email: email,
      back_url: `${portalBase}/aluno.html`,
      status: card_token_id ? 'authorized' : 'pending',
      auto_recurring: {
        frequency: cycleSpec.frequency,
        frequency_type: cycleSpec.frequency_type,
        transaction_amount: Number((finalAmount / 100).toFixed(2)),
        currency_id: 'BRL',
      },
    };
    if (card_token_id) preapprovalBody.card_token_id = String(card_token_id);

    const res = await this.fetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Idempotency-Key': idempotencyKey,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(preapprovalBody),
    });
    const data = await this.safeJson(res);
    if (!res.ok || !data?.id) {
      throw badReq(data?.message || data?.cause?.[0]?.description || `Erro ao criar assinatura Mercado Pago (${res.status})`);
    }

    const ins = this.store.run(
      `INSERT INTO mp_subscriptions
       (preapproval_id, external_ref, member_id, plan_id, amount_cents, frequency, frequency_type, payer_email, init_point, next_payment_date, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))`,
      [
        String(data.id),
        externalRef,
        member.id,
        plan?.id || null,
        finalAmount,
        cycleSpec.frequency,
        cycleSpec.frequency_type,
        email,
        data.init_point || null,
        data.next_payment_date || null,
        mapPreapprovalStatus(data.status),
      ],
    );

    return this.getSubscriptionById(ins.lastInsertRowid);
  }

  async createCardPayment({
    member_id,
    plan_id = null,
    token,
    payment_method_id,
    issuer_id = null,
    payer_email = null,
    identification_type = null,
    identification_number = null,
    device_id = null,
  }) {
    const settings = this.store.getSettings();
    const member = this.store.get('SELECT * FROM members WHERE id = ?', [Number(member_id)]);
    if (!member) throw new Error('Aluno não encontrado.');

    const cleanToken = String(token || '').trim();
    const cleanMethod = String(payment_method_id || '').trim();
    if (!cleanToken) throw new Error('Token do cartão não informado.');
    if (!cleanMethod) throw new Error('Bandeira do cartão não identificada.');

    const { plan, cents, charge } = this.resolveBillableMember(member, plan_id);
    const rawEmail = String(payer_email || member.email || '').trim();
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : `aluno${member.id}@academiaoxigenio.com`;
    const cpfDigits = String(identification_number || member.document || member.guardian_cpf || '').replace(/\D/g, '');
    const idType = identification_type || (cpfDigits.length === 14 ? 'CNPJ' : 'CPF');
    const externalRef = `ox_card:${member.id}:${crypto.randomUUID().slice(0, 8)}`;
    const description = `${settings.gym_name || 'Academia Oxigênio'} - ${plan?.name || 'Mensalidade'} (${member.name})`.slice(0, 250);

    const headers = {
      ...this.getMpAuth(settings),
      'X-Idempotency-Key': `mp_card:${member.id}:${cleanToken.slice(0, 32)}`,
    };
    if (device_id) headers['X-meli-session-id'] = String(device_id).slice(0, 128);

    const body = {
      transaction_amount: Number((cents / 100).toFixed(2)),
      token: cleanToken,
      description,
      installments: 1,
      payment_method_id: cleanMethod,
      external_reference: externalRef,
      payer: {
        email,
        ...(cpfDigits ? { identification: { type: idType, number: cpfDigits } } : {}),
      },
    };
    if (issuer_id) body.issuer_id = String(issuer_id);

    const response = await this.fetch('https://api.mercadopago.com/v1/payments', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(body),
    });
    const data = await this.safeJson(response);
    if (!response.ok || !data?.id) {
      const err = new Error(data?.message || data?.cause?.[0]?.description || 'Não foi possível processar o pagamento no cartão.');
      err.status = 400;
      throw err;
    }

    const mpStatus = String(data.status || '').toLowerCase();
    const localStatus = mpStatus === 'approved' ? 'approved' : (mpStatus === 'in_process' || mpStatus === 'pending' ? 'pending' : 'rejected');
    const res = this.store.run(
      `INSERT INTO gateway_charges
       (provider, external_id, member_id, plan_id, amount_cents, status, membership_charge_id, checkout_ref)
       VALUES ('mercadopago', ?, ?, ?, ?, ?, ?, ?)`,
      [String(data.id), member.id, plan?.id || null, cents, localStatus, charge?.id ?? null, externalRef],
    );
    const saved = this.store.get('SELECT * FROM gateway_charges WHERE id = ?', [res.lastInsertRowid]);
    if (mpStatus === 'approved') {
      await this.settleCharge(saved, { paymentId: String(data.id), method: 'credit', notes: 'Cartão transparente (Mercado Pago)' });
    }

    return {
      id: saved.id,
      external_id: String(data.id),
      status: mpStatus,
      status_detail: data.status_detail || null,
      approved: mpStatus === 'approved',
      amount_cents: cents,
      plan_name: plan?.name || 'Mensalidade',
    };
  }

  async settleMpSubscriptionPayment({ sub, mpPaymentId, amountCents, method = 'credit' }) {
    if (!mpPaymentId || !Number.isSafeInteger(amountCents) || amountCents !== sub.amount_cents) {
      throw new Error('Valor confirmado difere da assinatura registrada.');
    }

    const paymentResult = await this.accessService.recordPayment(
      {
        member_id: sub.member_id,
        plan_id: sub.plan_id,
        amount_cents: amountCents,
        method,
        external_id: `mercadopago:${mpPaymentId}`,
        notes: `Assinatura Mercado Pago (${sub.preapproval_id})`,
      },
      { reconcileOpenCharge: true, separateOnlineCash: true },
    );

    if (this.whatsappService && !paymentResult.alreadyRecorded) {
      this.whatsappService.enqueuePaymentReceipt(paymentResult).catch(() => {});
    }

    return { alreadyPaid: Boolean(paymentResult.alreadyRecorded), paymentResult };
  }

  async syncMpSubscription(id) {
    const sub = this.store.get('SELECT * FROM mp_subscriptions WHERE id = ?', [Number(id)]);
    if (!sub) throw this._badRequest('Assinatura não encontrada.');

    const headers = this.getMpAuth();
    const preRes = await this.mpFetchWithRetry(`https://api.mercadopago.com/preapproval/${encodeURIComponent(sub.preapproval_id)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const preData = await this.safeJson(preRes);
    if (!preRes.ok) {
      throw this._badRequest(preData?.message || `Erro ao consultar assinatura Mercado Pago (${preRes.status})`);
    }

    let settledCount = 0;
    const searchUrl = `https://api.mercadopago.com/v1/payments/search?external_reference=${encodeURIComponent(sub.external_ref)}&status=approved&sort=date_created&criteria=desc`;
    const payRes = await this.mpFetchWithRetry(searchUrl, { headers, signal: AbortSignal.timeout(15000) });
    if (payRes.ok) {
      const payJson = await this.safeJson(payRes);
      const results = Array.isArray(payJson?.results) ? payJson.results : [];
      for (const item of results) {
        if (item.status !== 'approved' || (item.external_reference && item.external_reference !== sub.external_ref)) continue;
        const amountCents = Math.round(Number(item.transaction_amount) * 100);
        try {
          const settled = await this.settleMpSubscriptionPayment({
            sub,
            mpPaymentId: item.id,
            amountCents,
            method: item.payment_type_id === 'debit_card' ? 'debit' : 'credit',
          });
          if (!settled.alreadyPaid) settledCount += 1;
        } catch (err) {
          console.warn(`[GatewayService] Pagamento ${item.id} da assinatura ${sub.id} ignorado:`, err.message);
        }
      }
    }

    this.store.run(
      `UPDATE mp_subscriptions
       SET status = ?, next_payment_date = COALESCE(?, next_payment_date), updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [mapPreapprovalStatus(preData?.status), preData?.next_payment_date || null, sub.id],
    );

    return {
      settledCount,
      subscription: this.getSubscriptionById(sub.id),
    };
  }

  async cancelMpSubscription(id) {
    const sub = this.store.get('SELECT * FROM mp_subscriptions WHERE id = ?', [Number(id)]);
    if (!sub) throw this._badRequest('Assinatura não encontrada.');
    if (sub.status === 'canceled') {
      return { alreadyCanceled: true, subscription: this.getSubscriptionById(sub.id) };
    }

    const headers = this.getMpAuth();
    const res = await this.fetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(sub.preapproval_id)}`, {
      method: 'PUT',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ status: 'cancelled' }),
    });
    if (!res.ok && res.status !== 404) {
      const data = (await this.safeJson(res)) || {};
      throw this._badRequest(data?.message || `Erro ao cancelar assinatura Mercado Pago (${res.status})`);
    }

    this.store.run(
      `UPDATE mp_subscriptions
       SET status = 'canceled', canceled_at = datetime('now', 'localtime'), updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [sub.id],
    );

    return { alreadyCanceled: false, subscription: this.getSubscriptionById(sub.id) };
  }

  // --- Mercado Pago Point Smart ---

  async listPointTerminals() {
    const headers = this.getPointAuth();
    const res = await this.mpFetchWithRetry('https://api.mercadopago.com/terminals/v1/list', { headers, signal: AbortSignal.timeout(15000) });
    const data = (await this.safeJson(res)) || {};
    if (!res.ok) {
      const detail = data?.message || data?.errors?.[0]?.message || data?.cause?.[0]?.description || '';
      throw this._badRequest(detail ? `${detail} (HTTP ${res.status})` : `Erro ao listar maquininhas Point (HTTP ${res.status})`);
    }
    return data?.data?.terminals || data?.terminals || (Array.isArray(data?.data) ? data.data : []);
  }

  async setPointTerminalMode(terminalId, operatingMode = 'PDV') {
    const settings = this.store.getSettings();
    const headers = this.getPointAuth(settings);
    const id = this.getPointTerminalId(terminalId, settings);
    if (!id) throw this._badRequest('Informe o ID da maquininha Point.');
    const mode = ['PDV', 'STANDALONE'].includes(String(operatingMode).toUpperCase())
      ? String(operatingMode).toUpperCase()
      : 'PDV';

    const res = await this.fetch('https://api.mercadopago.com/terminals/v1/setup', {
      method: 'PATCH',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        terminals: [{ id, operating_mode: mode }],
      }),
    });
    const data = (await this.safeJson(res)) || {};
    if (!res.ok) {
      const detail = data?.message || data?.errors?.[0]?.message || data?.cause?.[0]?.description || '';
      throw this._badRequest(detail ? `${detail} (HTTP ${res.status})` : `Erro ao configurar modo da maquininha (HTTP ${res.status})`);
    }
    return { terminalId: id, operatingMode: mode, data };
  }

  listPointOrders(limit = 20) {
    return this.store.all(
      `SELECT po.*, m.name AS member_name, p.name AS plan_name
       FROM point_orders po
       JOIN members m ON m.id = po.member_id
       LEFT JOIN plans p ON p.id = po.plan_id
       ORDER BY CASE WHEN po.status = 'pending' THEN 0 ELSE 1 END, po.id DESC
       LIMIT ?`,
      [Number(limit)],
    );
  }

  getPointOrderById(id) {
    return this.store.get(
      `SELECT po.*, m.name AS member_name, p.name AS plan_name
       FROM point_orders po
       JOIN members m ON m.id = po.member_id
       LEFT JOIN plans p ON p.id = po.plan_id
       WHERE po.id = ?`,
      [Number(id)],
    );
  }

  getStoneAuth(settings = this.store.getSettings()) {
    const key = String(process.env.STONE_API_KEY || settings?.stone_api_key || '').trim();
    if (!key) {
      throw this._badRequest('Configure a chave API da Stone / Pagar.me em Configurações.');
    }
    const basic = Buffer.from(`${key}:`).toString('base64');
    return {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/json',
    };
  }

  getStoneSerial(terminalId = null, settings = this.store.getSettings()) {
    return String(terminalId || process.env.STONE_TERMINAL_SERIAL || settings?.stone_terminal_serial || '').trim();
  }

  resolvePosProvider(provider = null, settings = this.store.getSettings()) {
    const explicit = String(provider || '').trim().toLowerCase();
    if (explicit === 'stone' || explicit === 'mercadopago') return explicit;
    const configured = String(settings?.pos_provider || '').trim().toLowerCase();
    if (configured === 'stone') return 'stone';
    if (settings?.stone_enabled === '1' && (process.env.STONE_API_KEY || settings?.stone_api_key) && !settings?.mp_point_access_token) {
      return 'stone';
    }
    return 'mercadopago';
  }

  async _markPointOrderPaid(order, method, externalId, notes) {
    let batchItems = null;
    if (order.batch_items_json) {
      try {
        const parsed = JSON.parse(order.batch_items_json);
        if (Array.isArray(parsed) && parsed.length > 0) batchItems = parsed;
      } catch {
        batchItems = null;
      }
    }

    if (batchItems) {
      const paymentResults = [];
      for (let i = 0; i < batchItems.length; i += 1) {
        const item = batchItems[i];
        const res = await this.accessService.recordPayment(
          {
            member_id: item.member_id,
            plan_id: item.plan_id,
            amount_cents: item.amount_cents,
            method,
            external_id: `${externalId}:batch:${item.member_id}:${i}`,
            charge_id: item.charge_id ?? null,
            notes: `${notes} (Carrinho ${i + 1}/${batchItems.length})`,
          },
          {
            reconcileOpenCharge: true,
            exactCharge: Boolean(item.charge_id),
            onRecorded: i === 0
              ? (paymentId) => this.store.run(
                  `UPDATE point_orders SET status = 'paid', payment_method = ?, payment_id = ?, paid_at = COALESCE(paid_at, datetime('now', 'localtime')) WHERE id = ? AND status <> 'paid'`,
                  [method, paymentId, order.id],
                )
              : undefined,
          },
        );
        if (this.whatsappService && !res.alreadyRecorded) {
          this.whatsappService.enqueuePaymentReceipt(res).catch(() => {});
        }
        paymentResults.push(res);
      }
      return {
        paid: true,
        alreadyPaid: paymentResults.every((r) => Boolean(r.alreadyRecorded)),
        order: this.getPointOrderById(order.id),
        paymentResult: paymentResults[0] || null,
        paymentResults,
      };
    }

    const openCharge = order.membership_charge_id
      ? this.store.get('SELECT * FROM membership_charges WHERE id = ? AND payment_id IS NULL', [order.membership_charge_id])
      : this.store.get('SELECT * FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due ASC, id ASC LIMIT 1', [order.member_id]);

    if (openCharge && Number(order.amount_cents) > 0 && Number(order.amount_cents) < Number(openCharge.amount)) {
      const existingPartial = externalId
        ? this.store.get('SELECT * FROM payments WHERE external_id = ?', [externalId])
        : null;
      if (existingPartial) {
        return {
          paid: true,
          alreadyPaid: true,
          partial: true,
          remaining_cents: openCharge.amount,
          order: this.getPointOrderById(order.id),
          paymentResult: { payment: existingPartial, member: this.accessService.getMember(order.member_id), alreadyRecorded: true },
        };
      }

      const { paymentId, remainingCents } = this.store.transaction(() => {
        const payRes = this.store.run(
          `INSERT INTO payments (member_id, plan_id, amount_cents, method, external_id, notes, status, paid_at)
           VALUES (?, ?, ?, ?, ?, ?, 'paid', datetime('now', 'localtime'))`,
          [
            order.member_id,
            order.plan_id || null,
            order.amount_cents,
            method,
            externalId,
            `${notes} (Parcela parcial)`,
          ],
        );
        const newRemaining = Math.max(1, Number(openCharge.amount) - Number(order.amount_cents));
        this.store.run(
          `UPDATE membership_charges SET amount = ? WHERE id = ? AND payment_id IS NULL`,
          [newRemaining, openCharge.id],
        );
        this.store.run(
          `UPDATE point_orders SET status = 'paid', payment_method = ?, payment_id = ?, paid_at = COALESCE(paid_at, datetime('now', 'localtime')) WHERE id = ? AND status <> 'paid'`,
          [method, payRes.lastInsertRowid, order.id],
        );
        return { paymentId: payRes.lastInsertRowid, remainingCents: newRemaining };
      });
      const payment = this.store.get('SELECT * FROM payments WHERE id = ?', [paymentId]);
      const member = this.accessService.getMember(order.member_id);
      return {
        paid: true,
        alreadyPaid: false,
        partial: true,
        remaining_cents: remainingCents,
        order: this.getPointOrderById(order.id),
        paymentResult: { payment, member, alreadyRecorded: false },
      };
    }

    const paymentResult = await this.accessService.recordPayment(
      {
        member_id: order.member_id,
        plan_id: order.plan_id,
        amount_cents: order.amount_cents,
        method,
        external_id: externalId,
        charge_id: order.membership_charge_id,
        notes,
      },
      {
        reconcileOpenCharge: true,
        exactCharge: Boolean(order.membership_charge_id),
        onRecorded: (paymentId) => this.store.run(
          `UPDATE point_orders SET status = 'paid', payment_method = ?, payment_id = ?, paid_at = COALESCE(paid_at, datetime('now', 'localtime')) WHERE id = ? AND status <> 'paid'`,
          [method, paymentId, order.id],
        ),
      },
    );
    if (this.whatsappService && !paymentResult.alreadyRecorded) {
      this.whatsappService.enqueuePaymentReceipt(paymentResult).catch(() => {});
    }
    return {
      paid: true,
      alreadyPaid: Boolean(paymentResult.alreadyRecorded),
      order: this.getPointOrderById(order.id),
      paymentResult,
    };
  }

  async createPointOrder({ member_id = null, plan_id = null, amount_cents = null, terminal_id = null, payment_method = 'credit', provider = null, items = null }) {
    const settings = this.store.getSettings();
    const activeProvider = this.resolvePosProvider(provider, settings);
    if (activeProvider === 'stone' && !Array.isArray(items)) {
      return this._createStoneOrder({ member_id, plan_id, amount_cents, terminal_id, payment_method, settings });
    }
    const headers = this.getPointAuth(settings);
    const productionTerminal = this.getPointTerminalId(terminal_id, settings);
    const chosenTerminal = process.env.MP_POINT_TEST_MODE === 'true' ? 'NEWLAND_N950__SBX0000001' : productionTerminal;
    if (!chosenTerminal) {
      throw this._badRequest('Configure o ID da maquininha Point Smart em Configurações.');
    }

    let primaryMember;
    let primaryPlan;
    let primaryCharge;
    let finalAmount;
    let resolvedBatch = null;
    let description;

    if (Array.isArray(items) && items.length > 0) {
      resolvedBatch = [];
      let sum = 0;
      for (const raw of items) {
        const m = this.store.get('SELECT * FROM members WHERE id = ?', [Number(raw?.member_id)]);
        if (!m) throw this._badRequest(`Aluno #${raw?.member_id || '?'} não encontrado.`);
        const resolved = this.resolveBillableMember(m, raw?.plan_id ?? null, raw?.amount_cents ?? null);
        resolvedBatch.push({
          member_id: m.id,
          member_name: m.name,
          plan_id: resolved.plan.id,
          plan_name: resolved.plan.name,
          amount_cents: resolved.cents,
          charge_id: resolved.charge?.id ?? null,
        });
        sum += resolved.cents;
        if (!primaryMember) {
          primaryMember = m;
          primaryPlan = resolved.plan;
          primaryCharge = resolved.charge;
        }
      }
      finalAmount = sum;
      description = `${settings.gym_name || 'Academia'} - Lote ${resolvedBatch.length} aluno(s)`.slice(0, 100);
    } else {
      primaryMember = this.store.get('SELECT * FROM members WHERE id = ?', [Number(member_id)]);
      if (!primaryMember) throw this._badRequest('Aluno não encontrado.');
      const resolved = this.resolveBillableMember(primaryMember, plan_id, amount_cents);
      primaryPlan = resolved.plan;
      finalAmount = resolved.cents;
      primaryCharge = resolved.charge;
      description = `${settings.gym_name || 'Academia'} - ${primaryPlan?.name || 'Mensalidade'} (${primaryMember.name})`.slice(0, 100);

      if (primaryCharge?.id) {
        const existingPending = this.store.get(
          `SELECT id, order_id, terminal_id, amount_cents, payment_method FROM point_orders
           WHERE member_id = ? AND membership_charge_id = ? AND status = 'pending' AND provider = 'mercadopago'
           ORDER BY id DESC LIMIT 1`,
          [primaryMember.id, primaryCharge.id],
        );
        if (existingPending) {
          let shouldReuse = false;
          try {
            const stRes = await this.mpFetchWithRetry(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(existingPending.order_id)}`, {
              headers,
              signal: AbortSignal.timeout(8000),
            });
            const stData = await this.safeJson(stRes);
            const mpStatus = String(stData?.status || '').toLowerCase();
            if (!stRes.ok || ['canceled', 'cancelled', 'expired', 'failed'].includes(mpStatus)) {
              const norm = mpStatus === 'cancelled' ? 'canceled' : (mpStatus || 'expired');
              this.store.run(`UPDATE point_orders SET status = ? WHERE id = ? AND status <> 'paid'`, [norm, existingPending.id]);
            } else if (
              existingPending.amount_cents === finalAmount &&
              existingPending.terminal_id === chosenTerminal &&
              existingPending.payment_method === String(payment_method || 'credit')
            ) {
              shouldReuse = true;
            } else {
              await this.cancelPointOrder(existingPending.id).catch(() => {});
            }
          } catch {
            // Se falhar a consulta de status, tenta criar nova ordem normalmente
          }
          if (shouldReuse) return this.getPointOrderById(existingPending.id);
        }
      }
    }

    const member = primaryMember;
    const plan = primaryPlan;
    const charge = primaryCharge;
    const pointMethodMap = {
      credit: 'credit_card',
      credit_card: 'credit_card',
      debit: 'debit_card',
      debit_card: 'debit_card',
      pix: 'qr',
      qr: 'qr',
      voucher: 'voucher_card',
      voucher_card: 'voucher_card',
    };
    const defaultType = pointMethodMap[String(payment_method || '').trim().toLowerCase()] || null;
    const orderConfig = {
      point: {
        terminal_id: chosenTerminal,
        print_on_terminal: 'no_ticket',
      },
      ...(defaultType ? { payment_method: { default_type: defaultType } } : {}),
    };

    const idempotencyKey = `point_order:${member.id}:${charge?.id || 'adhoc'}:${chosenTerminal}:${finalAmount}:${Date.now()}`;
    const res = await this.fetch('https://api.mercadopago.com/v1/orders', {
      method: 'POST',
      headers: {
        ...headers,
        'X-Idempotency-Key': idempotencyKey,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        type: 'point',
        external_reference: String(member.id),
        expiration_time: 'PT16M',
        description,
        config: orderConfig,
        transactions: {
          payments: [
            {
              amount: (finalAmount / 100).toFixed(2),
            },
          ],
        },
      }),
    });

    const data = await this.safeJson(res);
    if (!res.ok || !data?.id) {
      throw this._badRequest(data?.message || data?.errors?.[0]?.message || `Erro ao enviar cobrança para Point (${res.status})`);
    }

    const ins = this.store.run(
      `INSERT INTO point_orders (order_id, terminal_id, member_id, plan_id, amount_cents, payment_method, status, membership_charge_id, provider, batch_items_json)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'mercadopago', ?)`,
      [
        String(data.id),
        chosenTerminal,
        member.id,
        plan.id,
        finalAmount,
        String(payment_method || 'credit'),
        resolvedBatch ? null : (charge?.id ?? null),
        resolvedBatch ? JSON.stringify(resolvedBatch) : null,
      ],
    );

    return this.getPointOrderById(ins.lastInsertRowid);
  }

  async _createStoneOrder({ member_id, plan_id = null, amount_cents = null, terminal_id = null, payment_method = 'credit', settings }) {
    const headers = this.getStoneAuth(settings);
    const chosenSerial = this.getStoneSerial(terminal_id, settings);
    if (!chosenSerial) {
      throw this._badRequest('Configure o serial da maquininha Stone em Configurações.');
    }

    const member = this.store.get('SELECT * FROM members WHERE id = ?', [Number(member_id)]);
    if (!member) throw this._badRequest('Aluno não encontrado.');

    const { plan, cents: finalAmount, charge } = this.resolveBillableMember(member, plan_id, amount_cents);
    if (charge?.id) {
      const existingPending = this.store.get(
        `SELECT id FROM point_orders WHERE member_id = ? AND membership_charge_id = ? AND status = 'pending' AND COALESCE(provider, 'mercadopago') = 'stone' ORDER BY id DESC LIMIT 1`,
        [member.id, charge.id],
      );
      if (existingPending) return this.getPointOrderById(existingPending.id);
    }

    const description = `${settings.gym_name || 'Academia'} - ${plan?.name || 'Mensalidade'} (${member.name})`.slice(0, 100);
    const doc = digitsOnly(member.document || member.guardian_cpf);
    const stoneType = payment_method === 'debit' ? 'debit' : payment_method === 'pix' ? 'pix' : 'credit';

    const res = await this.fetch('https://api.pagar.me/core/v5/orders', {
      method: 'POST',
      headers,
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        closed: false,
        customer: {
          name: member.name,
          type: 'individual',
          ...(doc.length >= 11 ? { document: doc } : {}),
        },
        items: [{ amount: finalAmount, description, quantity: 1 }],
        poi_payment_settings: {
          visible: true,
          print_order_receipt: false,
          devices_serial_number: [chosenSerial],
          payment_setup: {
            type: stoneType,
            installments: 1,
          },
        },
        metadata: {
          member_id: String(member.id),
          plan_id: String(plan.id),
          ...(charge?.id ? { membership_charge_id: String(charge.id) } : {}),
        },
      }),
    });

    const data = await this.safeJson(res);
    if (!res.ok || !data?.id) {
      throw this._badRequest(data?.message || data?.errors?.[0]?.message || `Erro ao enviar cobrança para Stone (${res.status})`);
    }

    const ins = this.store.run(
      `INSERT INTO point_orders (order_id, terminal_id, member_id, plan_id, amount_cents, payment_method, status, membership_charge_id, provider)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 'stone')`,
      [String(data.id), chosenSerial, member.id, plan.id, finalAmount, String(payment_method || 'credit'), charge?.id ?? null],
    );

    return this.getPointOrderById(ins.lastInsertRowid);
  }

  async checkPointOrder(id) {
    const order = this.store.get('SELECT * FROM point_orders WHERE id = ?', [Number(id)]);
    if (!order) throw this._badRequest('Cobrança da maquininha não encontrada.');
    if (order.status === 'paid') {
      return { paid: true, alreadyPaid: true, order: this.getPointOrderById(order.id) };
    }

    if (order.provider === 'stone') {
      const headers = this.getStoneAuth();
      const res = await this.fetch(`https://api.pagar.me/core/v5/orders/${encodeURIComponent(order.order_id)}`, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      const data = await this.safeJson(res);
      if (!res.ok) {
        throw this._badRequest(data?.message || `Erro ao consultar pedido Stone (${res.status})`);
      }
      const orderStatus = String(data?.status || '').toLowerCase();
      if (orderStatus === 'paid') {
        const payMethodRaw = String(data?.charges?.[0]?.payment_method || order.payment_method || 'credit').toLowerCase();
        const method = payMethodRaw.includes('debit') ? 'debit' : payMethodRaw.includes('pix') ? 'pix' : 'credit';
        return this._markPointOrderPaid(order, method, `stone_order:${order.order_id}`, `Stone POS (${order.terminal_id})`);
      }
      if (['canceled', 'failed'].includes(orderStatus)) {
        this.store.run(`UPDATE point_orders SET status = ? WHERE id = ? AND status <> 'paid'`, [orderStatus, order.id]);
      }
      return { paid: false, status: orderStatus || 'pending', order: this.getPointOrderById(order.id) };
    }

    const headers = this.getPointAuth();
    const res = await this.mpFetchWithRetry(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(order.order_id)}`, {
      headers,
      signal: AbortSignal.timeout(15000),
    });
    const data = await this.safeJson(res);
    if (!res.ok) {
      throw this._badRequest(data?.message || data?.errors?.[0]?.message || `Erro ao consultar ordem Point (${res.status})`);
    }

    const payItem = data?.transactions?.payments?.[0];
    const orderStatus = String(data?.status || '').toLowerCase();
    const payStatus = String(payItem?.status || '').toLowerCase();

    if (orderStatus === 'processed' || payStatus === 'processed') {
      if (Math.round(Number(payItem?.amount) * 100) !== order.amount_cents) {
        throw this._badRequest('Valor processado pela maquininha difere da cobrança registrada.');
      }
      const mpType = String(payItem?.payment_method?.type || '').toLowerCase();
      const method = mpType === 'debit_card' ? 'debit' : mpType === 'pix' ? 'pix' : order.payment_method || 'credit';
      const extKey = `mp_order:${order.order_id}`;
      return this._markPointOrderPaid(order, method, extKey, `Point Smart (${order.terminal_id})`);
    }

    if (['canceled', 'cancelled', 'expired', 'failed'].includes(orderStatus)) {
      const normalized = orderStatus === 'cancelled' ? 'canceled' : orderStatus;
      this.store.run(`UPDATE point_orders SET status = ? WHERE id = ? AND status <> 'paid'`, [normalized, order.id]);
    }

    return { paid: false, status: orderStatus || 'pending', order: this.getPointOrderById(order.id) };
  }

  async cancelPointOrder(id) {
    const order = this.store.get('SELECT * FROM point_orders WHERE id = ?', [Number(id)]);
    if (!order) throw this._badRequest('Cobrança da maquininha não encontrada.');
    if (order.status === 'paid') throw this._badRequest('Cobrança já foi paga e não pode ser cancelada.');

    if (order.provider === 'stone') {
      const headers = this.getStoneAuth();
      const res = await this.fetch(`https://api.pagar.me/core/v5/orders/${encodeURIComponent(order.order_id)}/closed`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ status: 'canceled' }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok && res.status !== 404) {
        const data = (await this.safeJson(res)) || {};
        throw this._badRequest(data?.message || `Erro ao cancelar pedido na Stone (${res.status})`);
      }
      this.store.run(`UPDATE point_orders SET status = 'canceled' WHERE id = ?`, [order.id]);
      return { canceled: true, order: this.getPointOrderById(order.id) };
    }

    const headers = this.getPointAuth();
    const res = await this.fetch(`https://api.mercadopago.com/v1/orders/${encodeURIComponent(order.order_id)}/cancel`, {
      method: 'POST',
      headers: {
        ...headers,
        'X-Idempotency-Key': `cancel_point_order:${order.order_id}:${Date.now()}`,
        'x-allow-cancelable-status': 'at_terminal',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && res.status !== 404) {
      const data = (await this.safeJson(res)) || {};
      throw this._badRequest(data?.message || data?.errors?.[0]?.message || `Erro ao cancelar cobrança na Point (${res.status})`);
    }

    this.store.run(`UPDATE point_orders SET status = 'canceled' WHERE id = ?`, [order.id]);
    return { canceled: true, order: this.getPointOrderById(order.id) };
  }

  verifyWebhookSignature(payload, headers, settings = this.store.getSettings()) {
    const secrets = [...new Set([
      String(process.env.MP_WEBHOOK_SECRET || settings?.mp_webhook_secret || '').trim(),
      String(process.env.MP_POINT_WEBHOOK_SECRET || settings?.mp_point_webhook_secret || '').trim(),
    ].filter(Boolean))];
    if (!secrets.length || !headers || typeof headers !== 'object') return;

    const getHeader = (name) => {
      for (const [k, v] of Object.entries(headers)) {
        if (k.toLowerCase() === name) return Array.isArray(v) ? v[0] : v;
      }
      return '';
    };

    const rawSig = String(getHeader('x-signature') || '').trim();
    const parts = new URLSearchParams(rawSig.replaceAll(',', '&'));
    const timestamp = parts.get('ts')?.trim() || '';
    const signature = parts.get('v1')?.trim() || '';
    const requestId = String(getHeader('x-request-id') || '').trim();
    const itemId = String(payload?.data?.id || payload?.id || '').trim();
    const manifest = `id:${itemId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;

    const a = Buffer.from(signature, 'utf8');
    const valid = Boolean(timestamp && signature && secrets.some((secret) => {
      const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      const b = Buffer.from(expected, 'utf8');
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    }));
    if (!valid) {
      const err = new Error('Assinatura do webhook Mercado Pago inválida.');
      err.statusCode = 401;
      throw err;
    }
  }

  async handleStoneWebhook(payload = {}) {
    const eventType = String(payload?.type || '').toLowerCase();
    const data = payload?.data || {};
    const orderId = String(data?.order?.id || (eventType.startsWith('order.') ? data?.id : '') || '').trim();
    if (!orderId) return { ignored: true };

    const order = this.store.get(
      "SELECT * FROM point_orders WHERE order_id = ? AND COALESCE(provider, 'mercadopago') = 'stone'",
      [orderId],
    );
    if (!order) return { ignored: true };

    if (eventType === 'charge.paid' || eventType === 'order.paid' || String(data?.status || '').toLowerCase() === 'paid') {
      if (order.status === 'paid') return { paid: true, alreadyPaid: true };
      const payloadAmount = data?.amount ?? data?.charges?.[0]?.amount ?? null;
      if (payloadAmount != null && Number(payloadAmount) !== Number(order.amount_cents)) {
        return { ignored: true, reason: 'amount_mismatch' };
      }
      const payMethodRaw = String(data?.payment_method || order.payment_method || 'credit').toLowerCase();
      const method = payMethodRaw.includes('debit') ? 'debit' : payMethodRaw.includes('pix') ? 'pix' : 'credit';
      return this._markPointOrderPaid(order, method, `stone_order:${order.order_id}`, `Stone POS (${order.terminal_id})`);
    }

    if (['charge.refunded', 'order.canceled', 'charge.canceled'].includes(eventType)) {
      this.store.run(`UPDATE point_orders SET status = 'canceled' WHERE id = ? AND status <> 'paid'`, [order.id]);
      return { canceled: true };
    }

    return { ignored: true };
  }

  async handleWebhook(provider, payload = {}, headers = null) {
    if (provider === 'stone') {
      return this.handleStoneWebhook(payload);
    }
    if (provider !== 'mercadopago') {
      throw new Error('Provider inválido.');
    }

    if (headers && typeof headers === 'object') {
      this.verifyWebhookSignature(payload, headers);
    }

    const itemId = payload?.data?.id || payload?.id;
    const eventType = String(payload?.type || '').toLowerCase();
    const action = String(payload?.action || '').toLowerCase();

    if (itemId && (['order', 'orders'].includes(eventType) || action.startsWith('order'))) {
      const pointOrder = this.store.get(`SELECT * FROM point_orders WHERE order_id = ? COLLATE NOCASE`, [String(itemId)]);
      if (pointOrder) {
        return await this.checkPointOrder(pointOrder.id);
      }
    }

    if (itemId && eventType === 'subscription_preapproval') {
      const sub = this.store.get(`SELECT * FROM mp_subscriptions WHERE preapproval_id = ?`, [String(itemId)]);
      if (sub) {
        return await this.syncMpSubscription(sub.id);
      }
      return { ignored: true, reason: 'subscription_not_found' };
    }

    if (itemId && (eventType === 'subscription_authorized_payment' || action.includes('authorized_payment'))) {
      const mpHeaders = this.getMpAuth();
      const authPayRes = await this.mpFetchWithRetry(`https://api.mercadopago.com/authorized_payments/${encodeURIComponent(String(itemId))}`, {
        headers: mpHeaders,
        signal: AbortSignal.timeout(15000),
      });
      if (authPayRes.ok) {
        const authPay = await this.safeJson(authPayRes);
        const sub = (authPay?.preapproval_id && this.store.get('SELECT * FROM mp_subscriptions WHERE preapproval_id = ?', [String(authPay.preapproval_id)]))
          || (authPay?.external_reference && this.store.get('SELECT * FROM mp_subscriptions WHERE external_ref = ?', [String(authPay.external_reference)]));
        if (sub) {
          return await this.syncMpSubscription(sub.id);
        }
      }
      return { ignored: true, reason: 'authorized_payment_subscription_not_found' };
    }

    const isPaymentEvent = !payload?.type || eventType === 'payment' || action.startsWith('payment');
    if (!itemId || !isPaymentEvent) {
      return { ignored: true };
    }

    const charge = this.store.get(
      `SELECT * FROM gateway_charges WHERE provider = 'mercadopago' AND external_id = ?`,
      [String(itemId)],
    );
    if (charge) {
      return await this.checkChargeStatus(charge.id);
    }

    // Verifica se o pagamento pertence a alguma assinatura recorrente do Mercado Pago
    const mpHeaders = this.getMpAuth();
    const res = await this.mpFetchWithRetry(`https://api.mercadopago.com/v1/payments/${encodeURIComponent(String(itemId))}`, {
      headers: mpHeaders,
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      const payData = await this.safeJson(res);
      if (payData?.status === 'approved' && payData?.external_reference) {
        const checkout = this.store.get('SELECT * FROM gateway_charges WHERE checkout_ref = ?', [String(payData.external_reference)]);
        if (checkout) return { paid: true, ...await this.settleCheckoutPayment(checkout, payData) };
        const sub = this.store.get(`SELECT * FROM mp_subscriptions WHERE external_ref = ?`, [String(payData.external_reference)]);
        if (sub) {
          const amountCents = Math.round(Number(payData.transaction_amount) * 100);
          const settled = await this.settleMpSubscriptionPayment({
            sub,
            mpPaymentId: itemId,
            amountCents,
            method: payData.payment_type_id === 'debit_card' ? 'debit' : 'credit',
          });
          return { paid: true, ...settled };
        }
      }
    }

    return { ignored: true, reason: 'charge_not_found' };
  }

  async syncActiveMpSubscriptions({ limit = 25 } = {}) {
    const settings = this.store.getSettings();
    if (!String(process.env.MP_ACCESS_TOKEN || settings?.mp_access_token || '').trim()) {
      return { checked: 0, settledCount: 0 };
    }
    const rows = this.store.all(
      `SELECT id FROM mp_subscriptions
       WHERE status IN ('active', 'authorized', 'pending')
       ORDER BY updated_at ASC, id ASC
       LIMIT ?`,
      [Math.max(1, Number(limit) || 25)],
    );
    let settledCount = 0;
    for (const row of rows) {
      try {
        const res = await this.syncMpSubscription(row.id);
        settledCount += Number(res?.settledCount || 0);
      } catch {
        // Ignora falha pontual para seguir sincronizando as demais assinaturas
      }
    }
    return { checked: rows.length, settledCount };
  }

  async syncPendingCharges({ limit = 25 } = {}) {
    const settings = this.store.getSettings();
    if (!String(process.env.MP_ACCESS_TOKEN || settings?.mp_access_token || '').trim()) {
      return { checked: 0, paidCount: 0 };
    }
    const rows = this.store.all(
      `SELECT id FROM gateway_charges
       WHERE provider = 'mercadopago' AND status = 'pending'
         AND created_at >= datetime('now', 'localtime', '-72 hours')
       ORDER BY id DESC
       LIMIT ?`,
      [Math.max(1, Number(limit) || 25)],
    );
    let paidCount = 0;
    for (const row of rows) {
      try {
        const res = await this.checkChargeStatus(row.id);
        if (res?.paid) paidCount += 1;
      } catch {
        // Ignora falha pontual para continuar verificando as demais cobranças
      }
    }
    return { checked: rows.length, paidCount };
  }
}
