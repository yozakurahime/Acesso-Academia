import { normalizeBrPhone } from './whatsappService.js';

const PAYMENT_INTENT_REGEX = /\b(pagar|pagamento|mensalidade|renovar|renova[cç][aã]o|pix|link\s+de\s+pagamento|quero\s+pagar)\b/i;
const ENROLLMENT_INTENT_REGEX = /\b(quero\s+me\s+matricular|fazer\s+matr[ií]cula|fazer\s+cadastro|me\s+cadastrar|nova\s+matr[ií]cula)\b/i;
const FLOW_CANCEL_REGEX = /^(cancelar|sair|voltar|depois|n[aã]o\s+quero)$/i;
const PAYMENT_PIX_CHOICE_REGEX = /^(1|pix|qr|copia\s+e\s+cola)$/i;
const PAYMENT_LINK_CHOICE_REGEX = /^(2|link|cart[aã]o|cr[eé]dito|d[eé]bito)$/i;
const PAYMENT_CHECK_REGEX = /\b(j[aá]\s+paguei|paguei|verificar|confirmar\s+pagamento|conferir)\b/i;
const PAYMENT_DISCOUNT_REGEX = /\b(desconto|abatimento|pagar\s+menos|valor\s+menor|metade|parcelar\s+no\s+pix|fiado|combinado|promo[cç][aã]o)\b/i;

export function formatBrl(cents) {
  return (Number(cents || 0) / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function stripAccents(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function isValidCpfDigits(digits) {
  if (!/^\d{11}$/.test(digits) || /^(\d)\1{10}$/.test(digits)) return false;
  const calc = (len) => {
    let sum = 0;
    for (let i = 0; i < len; i += 1) sum += Number(digits[i]) * (len + 1 - i);
    const rem = (sum * 10) % 11;
    return rem === 10 ? 0 : rem;
  };
  return calc(9) === Number(digits[9]) && calc(10) === Number(digits[10]);
}

function formatCpfDigits(digits) {
  return `${digits.slice(0, 3)}.${digits.slice(3, 6)}.${digits.slice(6, 9)}-${digits.slice(9)}`;
}

/**
 * Especialista determinístico de Vendas Online & Financeiro (Mercado Pago + Matrícula Guiada).
 * Fica separado da Hime (atendimento/IA) para nunca depender de LLM em valores, descontos ou baixas.
 */
export class OnlineSalesBotService {
  constructor(store, {
    gatewayService = null,
    accessService = null,
    recordChatMessage = () => {},
    pauseContact = () => {},
    humanPauseMs = 4 * 60 * 60 * 1000,
    sessionTtlMs = 30 * 60 * 1000,
  } = {}) {
    this.store = store;
    this.gatewayService = gatewayService;
    this.accessService = accessService;
    this.recordChatMessage = recordChatMessage;
    this.pauseContact = pauseContact;
    this.humanPauseMs = humanPauseMs;
    this.sessionTtlMs = sessionTtlMs;
    this._sessions = new Map();
  }

  setGatewayService(gatewayService) {
    this.gatewayService = gatewayService || null;
  }

  setAccessService(accessService) {
    this.accessService = accessService || null;
  }

  _getSession(phone, nowMs = Date.now()) {
    const entry = this._sessions.get(phone);
    if (!entry) return null;
    if (nowMs - entry.updatedAt > this.sessionTtlMs) {
      this._sessions.delete(phone);
      return null;
    }
    return entry;
  }

  _setSession(phone, session, nowMs = Date.now()) {
    session.updatedAt = nowMs;
    this._sessions.set(phone, session);
    return session;
  }

  _resolveBillableList(members = []) {
    if (!this.gatewayService) return [];
    const items = [];
    for (const member of members) {
      try {
        const resolved = this.gatewayService.resolveBillableMember(member);
        items.push({
          member_id: member.id,
          member_name: member.name,
          plan_id: resolved.plan?.id || null,
          plan_name: resolved.plan?.name || 'Mensalidade',
          amount_cents: resolved.cents,
          document: member.document || '',
        });
      } catch {
        // Ignora cadastros sem plano/valor cobrável
      }
    }
    return items;
  }

  _findBillableMembersByPhone(phone) {
    const rows = this.store.all("SELECT * FROM members WHERE access_role = 'student'");
    const matches = rows.filter((m) => normalizeBrPhone(m.phone) === phone);
    return this._resolveBillableList(matches);
  }

  _findBillableMembersByQuery(rawQuery) {
    const cleaned = String(rawQuery || '')
      .replace(/^(adicionar|incluir|mais|tamb[eé]m|cpf|nome)\s*[:\-]?\s*/i, '')
      .trim();
    if (!cleaned) return [];
    const digits = cleaned.replace(/\D/g, '');
    const rows = this.store.all("SELECT * FROM members WHERE access_role = 'student'");

    let matches = [];
    if (digits.length === 11) {
      matches = rows.filter((m) => String(m.document || '').replace(/\D/g, '') === digits);
    }
    // Exige nome completo exato para evitar enumeração de alunos por terceiros
    if (!matches.length) {
      const needle = stripAccents(cleaned);
      if (needle.includes(' ') && needle.length >= 6) {
        matches = rows.filter((m) => stripAccents(m.name) === needle);
      }
    }
    return this._resolveBillableList(matches);
  }

  _formatPaymentSummary(items) {
    const total = items.reduce((sum, item) => sum + Number(item.amount_cents || 0), 0);
    const lines = items.map(
      (item, idx) => `${idx + 1}. *${item.member_name}* (${item.plan_name}) — *${formatBrl(item.amount_cents)}*`,
    );
    return { lines: lines.join('\n'), totalCents: total };
  }

  _buildPaymentMenuReply(items, prefix = '') {
    const { lines, totalCents } = this._formatPaymentSummary(items);
    return [
      prefix,
      lines,
      `\nTotal: *${formatBrl(totalCents)}*`,
      '\nComo deseja continuar?',
      '• Responda *1* para gerar o *Pix Copia e Cola*',
      '• Responda *2* para gerar o *Link de Pagamento (Cartão ou Pix)*',
      '• Ou envie o *CPF ou nome completo* de outra pessoa para incluir no mesmo pagamento',
      '• Responda *cancelar* para sair',
    ].filter(Boolean).join('\n');
  }

  _listOnlinePlans() {
    return this.store.all(
      `SELECT id, name, duration_days, price_cents
       FROM plans
       WHERE price_cents > 0 AND duration_days > 1
       ORDER BY price_cents ASC, id ASC
       LIMIT 6`,
    );
  }

  async _handleEnrollmentFlow({ phone, userText, session }) {
    if (!session) {
      const plans = this._listOnlinePlans();
      if (!plans.length) {
        const reply = 'Para fazer sua matrícula online agora (com cadastro, foto do FaceID e Pix), acesse: https://sistema.academiaoxigenio.com/matricula.html';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      this._setSession(phone, {
        kind: 'enroll',
        step: 'choose_plan',
        plans,
        chosenPlan: null,
        fullName: null,
      });
      const planLines = plans.map((p, idx) => `*${idx + 1}.* ${p.name} — *${formatBrl(p.price_cents)}*`).join('\n');
      const reply = [
        'Ótimo! Posso fazer sua matrícula por aqui agora mesmo pelo Mercado Pago (ou se preferir preencher com foto do FaceID, acesse https://sistema.academiaoxigenio.com/matricula.html).',
        '\nEscolha o número do plano desejado:',
        planLines,
        '\n_(Responda o número do plano ou *cancelar* para sair.)_',
      ].join('\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'choose_plan') {
      const idx = Number(String(userText).trim()) - 1;
      const chosen = Number.isInteger(idx) && idx >= 0 && idx < session.plans.length ? session.plans[idx] : null;
      if (!chosen) {
        const reply = `Responda apenas o número de *1 a ${session.plans.length}* para escolher o plano, ou *cancelar* para sair.`;
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      session.chosenPlan = chosen;
      session.step = 'ask_name';
      this._setSession(phone, session);
      const reply = `Plano escolhido: *${chosen.name}* (*${formatBrl(chosen.price_cents)}*).\n\nAgora me informe seu *nome completo*:`;
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'ask_name') {
      const name = String(userText || '').trim().replace(/\s+/g, ' ');
      if (name.length < 5 || !name.includes(' ') || /\d/.test(name)) {
        const reply = 'Por favor, informe seu *nome e sobrenome completos* (sem números):';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      session.fullName = name;
      session.step = 'ask_cpf';
      this._setSession(phone, session);
      const reply = `Certo, *${name}*! Agora informe seu *CPF (11 dígitos)* para finalizar o cadastro:`;
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'ask_cpf') {
      const digits = String(userText || '').replace(/\D/g, '');
      if (!isValidCpfDigits(digits)) {
        const reply = 'CPF inválido. Confira os 11 dígitos e envie novamente (ou responda *cancelar*):';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      const formattedCpf = formatCpfDigits(digits);
      const existingByCpf = this.store
        .all("SELECT * FROM members WHERE access_role = 'student'")
        .find((m) => String(m.document || '').replace(/\D/g, '') === digits);

      let member = existingByCpf || null;
      if (!member) {
        if (this.accessService?.createMember) {
          member = await this.accessService.createMember({
            name: session.fullName,
            document: formattedCpf,
            phone,
            plan_id: session.chosenPlan.id,
          });
        } else {
          const ins = this.store.run(
            "INSERT INTO members (name, document, phone, plan_id, status, access_role) VALUES (?, ?, ?, ?, 'pending', 'student')",
            [session.fullName, formattedCpf, phone, session.chosenPlan.id],
          );
          member = this.store.get('SELECT * FROM members WHERE id = ?', [ins.lastInsertRowid]);
        }
      }

      const items = this._resolveBillableList([member]);
      if (!items.length) {
        this._sessions.delete(phone);
        const reply = 'Cadastro localizado! Para finalizar a matrícula, acesse https://sistema.academiaoxigenio.com/matricula.html ou fale com nossa recepção.';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      this._setSession(phone, { kind: 'payment', items, pendingChargeId: null });
      const reply = this._buildPaymentMenuReply(
        items,
        `Cadastro pronto para *${member.name}*! Após o pagamento, você pode enviar sua foto do FaceID em https://sistema.academiaoxigenio.com/matricula.html ou na recepção:`,
      );
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    return null;
  }

  async handleMessage({ phone, userText, settings = this.store.getSettings?.() || {} }) {
    const existing = this._getSession(phone);
    const wantsPayment = PAYMENT_INTENT_REGEX.test(userText);
    const wantsEnroll = ENROLLMENT_INTENT_REGEX.test(userText);

    if (!existing && !wantsPayment && !wantsEnroll) return null;

    const mpConfigured = Boolean(this.gatewayService && String(settings.mp_access_token || '').trim());
    if (!mpConfigured) {
      if (!existing && (wantsPayment || wantsEnroll)) {
        if (wantsEnroll) {
          const reply = 'Você pode fazer sua matrícula online com foto do FaceID diretamente por aqui: https://sistema.academiaoxigenio.com/matricula.html\n\nSe preferir falar com nossa recepção, responda *atendente*.';
          this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
          return { reply, requiresHuman: false };
        }
        this.pauseContact(phone, this.humanPauseMs);
        const reply = 'Vou encaminhar seu atendimento para nossa equipe concluir seu pagamento por aqui.';
        this.recordChatMessage({
          phone,
          direction: 'out',
          senderType: 'bot',
          body: reply,
          needsHuman: true,
          handoffSummary: 'Pagamento solicitado (Mercado Pago não configurado)',
        });
        return { reply, requiresHuman: true, reason: 'mp_not_configured' };
      }
      return null;
    }

    if (existing && FLOW_CANCEL_REGEX.test(userText)) {
      this._sessions.delete(phone);
      const reply = 'Certo, cancelei o fluxo por aqui. Se precisar de outra ajuda, é só chamar!';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (existing?.kind === 'enroll' || (!existing && wantsEnroll && !wantsPayment)) {
      return this._handleEnrollmentFlow({ phone, userText, session: existing });
    }

    if (existing && PAYMENT_DISCOUNT_REGEX.test(userText)) {
      const prefix = 'Por aqui não aplicamos descontos nem valores menores — a cobrança segue sempre o valor normal da mensalidade.\n_(Se você tiver algum combinado especial, responda *atendente* para falar com a recepção.)_';
      const reply = existing.items.length > 0
        ? this._buildPaymentMenuReply(existing.items, prefix)
        : `${prefix}\n\nPara continuar no valor normal, informe o *CPF (11 dígitos)* ou *nome completo* do aluno, ou responda *cancelar*.`;
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (existing?.pendingChargeId && PAYMENT_CHECK_REGEX.test(userText)) {
      try {
        const check = await this.gatewayService.checkChargeStatus(existing.pendingChargeId);
        if (check.paid) {
          this._sessions.delete(phone);
          const reply = '✅ Pagamento confirmado! Todas as mensalidades foram baixadas e a catraca já está liberada. Bom treino!';
          this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
          return { reply, requiresHuman: false };
        }
        const reply = 'Ainda não recebemos a confirmação do Mercado Pago. Assim que o pagamento for concluído, a baixa e a liberação na catraca acontecem automaticamente!';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      } catch {
        const reply = 'Não consegui consultar agora, mas assim que o pagamento for aprovado a baixa é automática.';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
    }

    if (existing && existing.items.length > 0 && (PAYMENT_PIX_CHOICE_REGEX.test(userText) || PAYMENT_LINK_CHOICE_REGEX.test(userText))) {
      const mode = PAYMENT_LINK_CHOICE_REGEX.test(userText) ? 'checkout' : 'pix';
      try {
        const { charge, items, totalCents } = await this.gatewayService.createBatchPayment({
          memberIds: existing.items.map((i) => i.member_id),
          mode,
        });
        existing.pendingChargeId = charge.id;
        this._setSession(phone, existing);
        const { lines } = this._formatPaymentSummary(items);
        const reply = mode === 'pix'
          ? [
              '✅ *Pix gerado via Mercado Pago!*',
              lines,
              `Total: *${formatBrl(totalCents)}*`,
              '\nCopie e pague o código Pix abaixo no app do seu banco:',
              charge.qr_code || charge.payment_url || '',
              '\nAssim que pagar, a baixa e a liberação na catraca são automáticas (ou responda *"já paguei"* para conferir).',
            ].filter(Boolean).join('\n')
          : [
              '✅ *Link de pagamento gerado via Mercado Pago!*',
              lines,
              `Total: *${formatBrl(totalCents)}*`,
              '\nAcesse para pagar no Cartão ou Pix:',
              charge.payment_url,
              '\nAssim que concluir, a baixa e a liberação na catraca são automáticas!',
            ].join('\n');
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false, charge };
      } catch (err) {
        const reply = `Não consegui gerar a cobrança agora (${err.message}). Vou chamar um atendente para te ajudar.`;
        this.pauseContact(phone, this.humanPauseMs);
        this.recordChatMessage({
          phone,
          direction: 'out',
          senderType: 'bot',
          body: reply,
          needsHuman: true,
          handoffSummary: `Erro ao gerar cobrança MP: ${String(err.message || '').slice(0, 120)}`,
        });
        return { reply, requiresHuman: true, reason: 'payment_error' };
      }
    }

    if (!existing) {
      const ownItems = this._findBillableMembersByPhone(phone);
      const session = this._setSession(phone, { kind: 'payment', items: ownItems, pendingChargeId: null });
      const reply = ownItems.length > 0
        ? this._buildPaymentMenuReply(ownItems, 'Encontrei seu cadastro para pagamento:')
        : 'Claro! Para gerar o pagamento pelo Mercado Pago, informe o *CPF (11 dígitos)* ou o *nome completo* do aluno.\n\n_(Se quiser pagar para mais de uma pessoa tudo junto, é só enviar um por vez!)_';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false, session };
    }

    const found = this._findBillableMembersByQuery(userText);
    if (!found.length) {
      const reply = existing.items.length > 0
        ? this._buildPaymentMenuReply(existing.items, 'Não encontrei outro aluno ativo/com plano por esse nome ou CPF.')
        : 'Não encontrei nenhum aluno com plano vinculado por esse nome ou CPF. Confira e envie o *CPF (11 dígitos)* ou *nome completo*, ou responda *cancelar*.';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (found.length > 1) {
      const reply = 'Encontrei mais de um cadastro com esse nome exato. Por segurança, envie o *CPF (11 dígitos)* da pessoa que deseja incluir.';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    const picked = found[0];
    const already = existing.items.some((i) => i.member_id === picked.member_id);
    if (!already) {
      existing.items.push(picked);
      existing.pendingChargeId = null;
      this._setSession(phone, existing);
    }
    const prefix = already
      ? `*${picked.member_name}* já está na lista deste pagamento:`
      : `Adicionei *${picked.member_name}* ao pagamento:`;
    const reply = this._buildPaymentMenuReply(existing.items, prefix);
    this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
    return { reply, requiresHuman: false };
  }
}
