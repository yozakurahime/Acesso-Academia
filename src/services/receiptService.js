function normalizeText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function digitsOnly(str) {
  return String(str || '').replace(/\D/g, '');
}

const GEMINI_PROMPT = `Analise este arquivo (imagem ou PDF) enviado como comprovante de pagamento Pix/transferência para uma academia.
Responda APENAS com um objeto JSON válido com os seguintes campos:
{
  "is_receipt": boolean (true se for um comprovante de pagamento/transferência real, false caso contrário),
  "amount_reais": number ou null (valor pago em reais, ex: 150.00),
  "paid_date": string ou null (data do pagamento no formato YYYY-MM-DD),
  "payer_name": string ou null (nome de quem pagou / origem),
  "payer_document": string ou null (CPF/CNPJ de quem pagou, se visível),
  "recipient_name": string ou null (nome de quem recebeu / destino),
  "recipient_key": string ou null (chave Pix ou CPF/CNPJ do recebedor, se visível),
  "transaction_id": string ou null (ID da transação, EndToEndId, E2E ou código de autenticação),
  "confidence": integer (0 a 100 indicando confiança na leitura),
  "summary": string (resumo curto em português de até 120 caracteres)
}`;

export class ReceiptService {
  constructor(store, accessService, { whatsappService = null, fetchFn = globalThis.fetch } = {}) {
    this.store = store;
    this.accessService = accessService;
    this.whatsappService = whatsappService;
    this.fetch = fetchFn;
  }

  setWhatsappService(whatsappService) {
    this.whatsappService = whatsappService;
  }

  listReceipts(limit = 30) {
    return this.store.all(
      `SELECT pr.*, m.name AS member_name, m.phone AS member_phone, p.name AS plan_name, p.price_cents AS plan_price_cents
       FROM payment_receipts pr
       LEFT JOIN members m ON m.id = pr.member_id
       LEFT JOIN plans p ON p.id = pr.plan_id
       ORDER BY CASE WHEN pr.status = 'pending' THEN 0 ELSE 1 END, pr.id DESC
       LIMIT ?`,
      [Number(limit)],
    );
  }

  async analyzeWithGemini({ base64Data, mimeType, settings = this.store.getSettings() }) {
    const apiKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').replace(/^["']+|["']+$/g, '').trim();
    if (!apiKey) {
      throw new Error('Chave API do Gemini não configurada. Informe em Configurações → WhatsApp.');
    }
    const model = String(settings.gemini_model || 'gemini-3.8-flash').trim();
    const cleanBase64 = String(base64Data || '').replace(/^data:[^;]+;base64,/, '');
    if (!cleanBase64) throw new Error('Arquivo do comprovante vazio.');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const response = await this.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: GEMINI_PROMPT },
              {
                inlineData: {
                  mimeType: mimeType || 'image/jpeg',
                  data: cleanBase64,
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    });

    let json = null;
    if (typeof response.text === 'function') {
      const responseText = await response.text();
      try {
        json = responseText ? JSON.parse(responseText) : {};
      } catch {
        json = null;
      }
    } else if (typeof response.json === 'function') {
      json = await response.json().catch(() => null);
    }
    if (!response.ok) {
      throw new Error(json?.error?.message || `Erro na API Gemini (${response.status})`);
    }
    if (!json) {
      throw new Error('Resposta inválida da API Gemini.');
    }
    const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const cleaned = rawText.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(cleaned);
    } catch {
      throw new Error('Não foi possível interpretar a resposta da IA para este comprovante.');
    }

    const amountCents =
      typeof parsed.amount_reais === 'number' && Number.isFinite(parsed.amount_reais) && parsed.amount_reais > 0
        ? Math.round(parsed.amount_reais * 100)
        : null;

    return {
      is_receipt: Boolean(parsed.is_receipt),
      amount_cents: amountCents,
      paid_date: parsed.paid_date || null,
      payer_name: parsed.payer_name || null,
      payer_document: parsed.payer_document || null,
      recipient_name: parsed.recipient_name || null,
      recipient_key: parsed.recipient_key || null,
      transaction_id: parsed.transaction_id ? String(parsed.transaction_id).trim() : null,
      confidence: Math.max(0, Math.min(100, Number(parsed.confidence) || 0)),
      summary: String(parsed.summary || '').slice(0, 200),
    };
  }

  matchMember({ memberId = null, senderPhone = null, payerName = null, payerDocument = null }) {
    if (memberId) {
      const explicit = this.store.get('SELECT * FROM members WHERE id = ?', [Number(memberId)]);
      if (explicit) return explicit;
    }

    const docDigits = digitsOnly(payerDocument);
    if (docDigits.length >= 11) {
      const byDoc = this.store.get(
        `SELECT id, name, document, phone, plan_id, status, valid_until
         FROM members
         WHERE COALESCE(access_role, 'student') = 'student'
           AND replace(replace(replace(COALESCE(document, ''), '.', ''), '-', ''), ' ', '') = ?
         LIMIT 1`,
        [docDigits],
      );
      if (byDoc) return byDoc;
    }

    const phoneDigits = digitsOnly(senderPhone);
    if (phoneDigits.length >= 8) {
      const suffix = phoneDigits.slice(-8);
      const candidates = this.store.all(
        `SELECT id, name, document, phone, plan_id, status, valid_until
         FROM members
         WHERE COALESCE(access_role, 'student') = 'student'
           AND phone IS NOT NULL AND trim(phone) <> ''
           AND replace(replace(replace(replace(replace(phone, ' ', ''), '-', ''), '(', ''), ')', ''), '+', '') LIKE ?`,
        [`%${suffix}`],
      );
      const byPhone = candidates.find((m) => digitsOnly(m.phone).endsWith(suffix));
      if (byPhone) return byPhone;
    }

    const normPayer = normalizeText(payerName);
    if (normPayer) {
      const trimmedName = String(payerName || '').trim();
      const candidates = this.store.all(
        `SELECT id, name, document, phone, plan_id, status, valid_until
         FROM members
         WHERE COALESCE(access_role, 'student') = 'student'
           AND (lower(trim(name)) = lower(?) OR name GLOB '*[^ -~]*' OR ? GLOB '*[^ -~]*')`,
        [trimmedName, trimmedName],
      );
      const byName = candidates.find((m) => normalizeText(m.name) === normPayer);
      if (byName) return byName;
    }
    return null;
  }

  validateSafeguards({ extracted, member, settings = this.store.getSettings() }) {
    const warnings = [];
    let isDuplicate = false;

    if (!extracted.is_receipt || !extracted.amount_cents) {
      warnings.push('Arquivo não identificado com clareza como comprovante válido.');
    }

    if (extracted.transaction_id) {
      const usedPayment = this.store.get('SELECT id FROM payments WHERE external_id = ?', [extracted.transaction_id]);
      const usedReceipt = this.store.get(
        `SELECT id FROM payment_receipts WHERE transaction_id = ? AND status = 'approved'`,
        [extracted.transaction_id],
      );
      if (usedPayment || usedReceipt) {
        isDuplicate = true;
        warnings.push('ID de transação já utilizado anteriormente (comprovante duplicado).');
      }
    }

    const expectedName = normalizeText(settings.pix_recipient_name);
    if (expectedName && !extracted.recipient_name) warnings.push('Nome do destinatário não identificado.');
    if (expectedName && extracted.recipient_name) {
      const gotName = normalizeText(extracted.recipient_name);
      if (!gotName.includes(expectedName) && !expectedName.includes(gotName)) {
        warnings.push(`Destinatário diferente do esperado (${extracted.recipient_name}).`);
      }
    }

    const expectedKey = normalizeText(settings.pix_recipient_key);
    if (expectedKey && !extracted.recipient_key) warnings.push('Chave Pix do destinatário não identificada.');
    if (expectedKey && extracted.recipient_key) {
      const gotKey = normalizeText(extracted.recipient_key);
      const gotKeyDigits = digitsOnly(extracted.recipient_key);
      const expKeyDigits = digitsOnly(settings.pix_recipient_key);
      const matchesKey = gotKey === expectedKey || (expKeyDigits && gotKeyDigits === expKeyDigits);
      if (!matchesKey) {
        warnings.push(`Chave Pix de destino diferente da configurada (${extracted.recipient_key}).`);
      }
    }

    if (!member) {
      warnings.push('Aluno não identificado automaticamente.');
    }

    if (member?.plan_id && extracted.amount_cents) {
      const plan = this.store.get('SELECT price_cents FROM plans WHERE id = ?', [member.plan_id]);
      if (plan && Math.abs(plan.price_cents - extracted.amount_cents) > 50) {
        warnings.push(`Valor difere do plano do aluno.`);
      }
    }

    if (extracted.paid_date) {
      const dateStr = String(extracted.paid_date).slice(0, 10);
      const paidMs = Date.parse(`${dateStr}T12:00:00Z`);
      const fifteenDaysAgoMs = Date.now() - 15 * 24 * 60 * 60 * 1000;
      if (Number.isFinite(paidMs) && paidMs < fifteenDaysAgoMs) {
        warnings.push(`Data do comprovante (${dateStr}) é anterior a 15 dias — requer conferência manual.`);
      }
    }

    return { warnings, isDuplicate };
  }

  async processReceipt({ base64Data, mimeType = 'image/jpeg', senderPhone = null, source = 'whatsapp', memberId = null }) {
    const settings = this.store.getSettings();
    const extracted = await this.analyzeWithGemini({ base64Data, mimeType, settings });
    const member = this.matchMember({
      memberId,
      senderPhone,
      payerName: extracted.payer_name,
      payerDocument: extracted.payer_document,
    });

    const safeguards = this.validateSafeguards({ extracted, member, settings });
    const previewUrl =
      mimeType.startsWith('image/') && String(base64Data).length <= 600000
        ? base64Data.startsWith('data:')
          ? base64Data
          : `data:${mimeType};base64,${base64Data}`
        : null;

    const initialStatus = safeguards.isDuplicate ? 'duplicate' : 'pending';
    const res = this.store.run(
      `INSERT INTO payment_receipts (
        member_id, plan_id, sender_phone, source, mime_type, amount_cents, paid_date,
        payer_name, payer_document, recipient_name, recipient_key, transaction_id,
        confidence, is_receipt, raw_summary, image_data, status, reject_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        member?.id || null,
        member?.plan_id || null,
        senderPhone || null,
        source,
        mimeType,
        extracted.amount_cents,
        extracted.paid_date,
        extracted.payer_name,
        extracted.payer_document,
        extracted.recipient_name,
        extracted.recipient_key,
        extracted.transaction_id,
        extracted.confidence,
        extracted.is_receipt ? 1 : 0,
        extracted.summary,
        previewUrl,
        initialStatus,
        safeguards.warnings.join(' ') || null,
      ],
    );

    const receiptId = res.lastInsertRowid;

    return this.store.get(
      `SELECT pr.*, m.name AS member_name, p.name AS plan_name
       FROM payment_receipts pr
       LEFT JOIN members m ON m.id = pr.member_id
       LEFT JOIN plans p ON p.id = pr.plan_id
       WHERE pr.id = ?`,
      [receiptId],
    );
  }

  async approveReceipt(receiptId, { member_id, plan_id, amount_cents, method = 'pix' } = {}) {
    const id = Number(receiptId);
    const receipt = this.store.get('SELECT * FROM payment_receipts WHERE id = ?', [id]);
    if (!receipt) throw new Error('Comprovante não encontrado.');
    if (receipt.status === 'approved') throw new Error('Este comprovante já foi baixado.');
    if (receipt.status === 'duplicate') throw new Error('Comprovante duplicado não pode ser baixado.');

    const targetMemberId = Number(member_id || receipt.member_id);
    if (!targetMemberId) throw new Error('Selecione o aluno para dar baixa neste comprovante.');

    const targetAmount = Number(amount_cents || receipt.amount_cents);
    if (!targetAmount || targetAmount <= 0) throw new Error('Valor do comprovante inválido.');

    const targetPlanId = plan_id ? Number(plan_id) : receipt.plan_id || null;
    const externalId = receipt.transaction_id || `REC-${receipt.id}`;

    const paymentResult = await this.accessService.recordPayment(
      {
        member_id: targetMemberId,
        plan_id: targetPlanId,
        amount_cents: targetAmount,
        method,
        external_id: externalId,
        notes: `Baixa via comprovante IA (#${receipt.id})`,
      },
      { requireOpenCash: true, reconcileOpenCharge: true,
        onRecorded: (paymentId) => this.store.run(
          `UPDATE payment_receipts
           SET status = 'approved', member_id = ?, plan_id = ?, amount_cents = ?, payment_id = ?,
               reject_reason = NULL, processed_at = COALESCE(processed_at, datetime('now', 'localtime'))
           WHERE id = ?`,
          [targetMemberId, targetPlanId, targetAmount, paymentId, id],
        ) },
    );

    if (this.whatsappService && !paymentResult.alreadyRecorded) {
      this.whatsappService.enqueuePaymentReceipt(paymentResult).catch(() => {});
    }

    return {
      receipt: this.store.get('SELECT * FROM payment_receipts WHERE id = ?', [id]),
      paymentResult,
    };
  }

  rejectReceipt(receiptId, reason = 'Rejeitado pela recepção') {
    const id = Number(receiptId);
    const receipt = this.store.get('SELECT * FROM payment_receipts WHERE id = ?', [id]);
    if (!receipt) throw new Error('Comprovante não encontrado.');
    if (receipt.status === 'approved') throw new Error('Não é possível rejeitar um comprovante já baixado.');
    this.store.run(
      `UPDATE payment_receipts SET status = 'rejected', reject_reason = ?, processed_at = datetime('now', 'localtime') WHERE id = ?`,
      [String(reason || 'Rejeitado').trim(), id],
    );
    return this.store.get('SELECT * FROM payment_receipts WHERE id = ?', [id]);
  }
}
