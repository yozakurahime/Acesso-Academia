import { createHmac, timingSafeEqual } from 'node:crypto';
import { normalizeCpf } from '../utils/cpf.js';

export const PARTNER_PROVIDERS = ['wellhub', 'totalpass'];

function safeEqualString(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function equalWebhookSecret(provided, secret, rawBody = null) {
  const actual = String(provided || '').trim();
  const expected = String(secret || '').trim();
  if (!actual || !expected) return false;
  if (safeEqualString(actual, expected)) return true;
  if (rawBody !== null && rawBody !== undefined) {
    const hmacHex = createHmac('sha256', expected).update(rawBody).digest('hex');
    const normalized = actual.replace(/^sha256=/i, '').toLowerCase();
    if (safeEqualString(normalized, hmacHex)) return true;
  }
  return false;
}

function isSafeTotalpassConfirmUrl(rawUrl) {
  if (!rawUrl) return false;
  try {
    const parsed = new URL(rawUrl);
    return (
      parsed.protocol === 'https:' &&
      (parsed.hostname === 'gym-service-api.totalpass.com' || parsed.hostname === 'gym-service-api.totalpass.com.br') &&
      parsed.pathname.startsWith('/webhook_confirmations/')
    );
  } catch {
    return false;
  }
}

export function normalizePartnerInput({ partner_provider, wellhub_id } = {}) {
  const provider = String(partner_provider || '').trim().toLowerCase();
  if (!provider) return { partner_provider: null, wellhub_id: null };
  if (!PARTNER_PROVIDERS.includes(provider)) {
    const err = new Error('Convênio inválido. Escolha Wellhub ou TotalPass.');
    err.statusCode = 400;
    throw err;
  }
  if (provider === 'wellhub') {
    const cleanId = String(wellhub_id || '').trim();
    if (!cleanId) {
      const err = new Error('Informe o ID do Wellhub (Gympass) do aluno.');
      err.statusCode = 400;
      throw err;
    }
    return { partner_provider: 'wellhub', wellhub_id: cleanId };
  }
  return { partner_provider: 'totalpass', wellhub_id: null };
}

export class PartnerService {
  constructor(store, fetchFn = globalThis.fetch) {
    this.store = store;
    this.fetchFn = fetchFn;
  }

  hasCheckinToday(memberId, provider) {
    return Boolean(
      this.store.get(
        `SELECT id FROM partner_checkins
         WHERE member_id = ? AND provider = ? AND checkin_date = date('now', 'localtime') AND status = 'validated'
         LIMIT 1`,
        [Number(memberId), provider],
      ),
    );
  }

  findMemberByPartner(provider, identifier) {
    const clean = String(identifier || '').trim();
    if (!clean) return null;
    if (provider === 'wellhub') {
      return this.store.get(
        'SELECT * FROM members WHERE lower(trim(wellhub_id)) = lower(?) LIMIT 1',
        [clean],
      );
    }
    if (provider === 'totalpass') {
      const digits = normalizeCpf(clean);
      if (!digits) return null;
      return (
        this.store.get(
          `SELECT * FROM members
           WHERE document IS NOT NULL
             AND replace(replace(replace(replace(replace(replace(document, '.', ''), '-', ''), '/', ''), ' ', ''), '(', ''), ')', '') = ?
           ORDER BY id LIMIT 1`,
          [digits],
        ) || null
      );
    }
    return null;
  }

  recordCheckin({ provider, memberId = null, identifier, source = 'manual', externalId = null, rawPayload = null }) {
    const today = this.store.get("SELECT date('now', 'localtime') AS today").today;
    const cleanExternalId = externalId ? String(externalId).trim() : null;
    if (cleanExternalId) {
      const existingByExternal = this.store.get(
        `SELECT * FROM partner_checkins
         WHERE provider = ? AND external_id = ?
         ORDER BY id DESC LIMIT 1`,
        [provider, cleanExternalId],
      );
      if (existingByExternal) return existingByExternal;
    }
    if (memberId) {
      const existing = this.store.get(
        `SELECT * FROM partner_checkins
         WHERE member_id = ? AND provider = ? AND checkin_date = ? AND status = 'validated'
         ORDER BY id DESC LIMIT 1`,
        [Number(memberId), provider, today],
      );
      if (existing) return existing;
    }

    const res = this.store.run(
      `INSERT INTO partner_checkins (provider, member_id, identifier, checkin_date, source, status, external_id, raw_payload)
       VALUES (?, ?, ?, ?, ?, 'validated', ?, ?)`,
      [
        provider,
        memberId ? Number(memberId) : null,
        String(identifier || '').trim(),
        today,
        source,
        externalId || null,
        rawPayload ? JSON.stringify(rawPayload) : null,
      ],
    );
    return this.store.get('SELECT * FROM partner_checkins WHERE id = ?', [res.lastInsertRowid]);
  }

  async validateExternalCheckin(provider, identifier, settings) {
    if (provider === 'wellhub' && settings.wellhub_api_key && settings.wellhub_gym_id) {
      const url = `https://api.partners.gympass.com/access/v1/gyms/${encodeURIComponent(settings.wellhub_gym_id)}/checkins`;
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.wellhub_api_key}`,
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ gympass_id: identifier }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (text) console.warn(`[WELLHUB API ${response.status}]`, text.slice(0, 200));
        throw new Error(`Wellhub recusou o check-in (${response.status}): tente pelo app Wellhub.`);
      }
      const data = await response.json().catch(() => ({}));
      return { externalId: data?.id || data?.checkin_id || null, rawPayload: data };
    }

    if (provider === 'totalpass' && settings.totalpass_api_token && settings.totalpass_gym_id) {
      const url = `https://api.totalpass.com.br/partner/v1/gyms/${encodeURIComponent(settings.totalpass_gym_id)}/checkins`;
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${settings.totalpass_api_token}`,
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({ cpf: normalizeCpf(identifier) }),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        if (text) console.warn(`[TOTALPASS API ${response.status}]`, text.slice(0, 200));
        throw new Error(`TotalPass recusou o check-in (${response.status}): tente pelo app TotalPass.`);
      }
      const data = await response.json().catch(() => ({}));
      return { externalId: data?.id || data?.checkin_id || null, rawPayload: data };
    }

    return { externalId: null, rawPayload: null };
  }

  async registerMemberCheckin({ memberId = null, provider = null, identifier = null, source = 'manual' } = {}) {
    let member = memberId ? this.store.get('SELECT * FROM members WHERE id = ?', [Number(memberId)]) : null;
    const targetProvider = provider || member?.partner_provider;
    if (!PARTNER_PROVIDERS.includes(targetProvider)) {
      throw new Error('Selecione um convênio válido (Wellhub ou TotalPass).');
    }

    if (!member && identifier) {
      member = this.findMemberByPartner(targetProvider, identifier);
    }

    const targetIdentifier =
      identifier?.trim() ||
      (targetProvider === 'wellhub' ? member?.wellhub_id : normalizeCpf(member?.document));

    if (!targetIdentifier) {
      throw new Error(
        targetProvider === 'wellhub'
          ? 'Informe o ID do Wellhub para registrar o check-in.'
          : 'O aluno precisa ter um CPF cadastrado para o TotalPass.',
      );
    }

    const settings = this.store.getSettings();
    const external = await this.validateExternalCheckin(targetProvider, targetIdentifier, settings);
    const checkin = this.recordCheckin({
      provider: targetProvider,
      memberId: member?.id || null,
      identifier: targetIdentifier,
      source: external.externalId ? 'api' : source,
      externalId: external.externalId,
      rawPayload: external.rawPayload,
    });
    return { checkin, member };
  }

  handleWellhubWebhook(payload = {}, headers = {}, rawBody = null) {
    const settings = this.store.getSettings();
    const secret = String(settings.wellhub_webhook_secret || '').trim();
    if (!secret) {
      const err = new Error('Webhook Wellhub não configurado (wellhub_webhook_secret ausente).');
      err.statusCode = 503;
      throw err;
    }
    const provided =
      headers['x-wellhub-signature'] ||
      headers['x-gympass-signature'] ||
      headers['x-webhook-secret'] ||
      headers.authorization?.replace(/^Bearer\s+/i, '') ||
      '';
    if (!equalWebhookSecret(provided, secret, rawBody)) {
      const err = new Error('Assinatura do webhook Wellhub inválida.');
      err.statusCode = 401;
      throw err;
    }

    const wellhubId = String(
      payload?.gympass_id ||
        payload?.wellhub_id ||
        payload?.user?.unique_token ||
        payload?.event_data?.user?.unique_token ||
        payload?.data?.gympass_id ||
        payload?.data?.wellhub_id ||
        '',
    ).trim();

    if (!wellhubId) {
      const err = new Error('Webhook Wellhub sem identificador (gympass_id / wellhub_id).');
      err.statusCode = 400;
      throw err;
    }

    const member = this.findMemberByPartner('wellhub', wellhubId);
    const checkin = this.recordCheckin({
      provider: 'wellhub',
      memberId: member?.id || null,
      identifier: wellhubId,
      source: 'webhook',
      externalId: payload?.id || payload?.event_id || payload?.checkin_id || null,
      rawPayload: payload,
    });

    return { ok: true, matched: Boolean(member), member_id: member?.id || null, checkin };
  }

  async handleTotalpassWebhook(payload = {}, headers = {}, rawBody = null) {
    const settings = this.store.getSettings();
    const secret = String(settings.totalpass_webhook_secret || '').trim();
    if (!secret) {
      const err = new Error('Webhook TotalPass não configurado (totalpass_webhook_secret ausente).');
      err.statusCode = 503;
      throw err;
    }
    const provided =
      headers['x-totalpass-signature'] ||
      headers['x-webhook-secret'] ||
      headers.authorization?.replace(/^Bearer\s+/i, '') ||
      '';
    if (!equalWebhookSecret(provided, secret, rawBody)) {
      const err = new Error('Assinatura do webhook TotalPass inválida.');
      err.statusCode = 401;
      throw err;
    }

    const cpf = normalizeCpf(
      payload?.cpf ||
        payload?.user?.cpf ||
        payload?.member?.cpf ||
        payload?.document ||
        payload?.data?.cpf ||
        payload?.data?.user?.cpf ||
        '',
    );

    if (!cpf) {
      const err = new Error('Webhook TotalPass sem CPF do aluno.');
      err.statusCode = 400;
      throw err;
    }

    const member = this.findMemberByPartner('totalpass', cpf);
    const confirmUrl = String(
      payload?.endpoint || payload?.confirmation_url || payload?.data?.endpoint || '',
    ).trim();

    let confirmed = false;
    if (isSafeTotalpassConfirmUrl(confirmUrl)) {
      try {
        const resp = await this.fetchFn(confirmUrl, {
          method: 'POST',
          headers: { accept: 'application/json' },
          redirect: 'manual',
          signal: AbortSignal.timeout(10000),
        });
        confirmed = Boolean(resp?.ok);
      } catch (err) {
        console.warn('[TOTALPASS WEBHOOK] Falha ao confirmar endpoint TotalPass:', err?.message || err);
      }
    }

    const checkin = this.recordCheckin({
      provider: 'totalpass',
      memberId: member?.id || null,
      identifier: cpf,
      source: 'webhook',
      externalId: payload?.id || payload?.event_id || payload?.checkin_id || payload?.token || null,
      rawPayload: payload,
    });

    return { ok: true, matched: Boolean(member), member_id: member?.id || null, confirmed, checkin };
  }

  listCheckins({ date = null, provider = null, limit = 50 } = {}) {
    const conditions = [];
    const params = [];
    if (date) {
      conditions.push('pc.checkin_date = ?');
      params.push(date);
    }
    if (provider && PARTNER_PROVIDERS.includes(provider)) {
      conditions.push('pc.provider = ?');
      params.push(provider);
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(200, Math.max(1, Number(limit) || 50)));
    return this.store.all(
      `SELECT pc.id, pc.provider, pc.member_id, pc.identifier, pc.checkin_date,
              pc.source, pc.status, pc.external_id, pc.created_at,
              m.name AS member_name, m.document AS member_document
       FROM partner_checkins pc
       LEFT JOIN members m ON m.id = pc.member_id
       ${where}
       ORDER BY pc.id DESC
       LIMIT ?`,
      params,
    );
  }
}
