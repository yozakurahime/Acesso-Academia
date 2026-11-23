import { normalizeBrPhone } from './whatsappService.js';

const PAYMENT_INTENT_REGEX = /\b(pagar|pagamento|mensalidade|renovar|renova[cç][aã]o|pix|link\s+de\s+pagamento|quero\s+pagar)\b/i;
const ENROLLMENT_INTENT_REGEX = /\b(quero\s+me\s+matricular|fazer\s+matr[ií]cula|fazer\s+cadastro|me\s+cadastrar|nova\s+matr[ií]cula)\b/i;
const KIDS_SWIM_REGEX = /\b(nata[cç][aã]o\s*(?:baby|infantil|kids|crian[cç]a)|baby|infantil)\b/i;
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

const NAME_STOPWORDS = new Set(['da', 'de', 'do', 'dos', 'das', 'e']);

function nameTokens(value) {
  return stripAccents(value)
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !NAME_STOPWORDS.has(t));
}

function editDistanceAtMostOne(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1 || Math.min(la, lb) < 4) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i += 1;
      j += 1;
    } else {
      edits += 1;
      if (edits > 1) return false;
      if (la > lb) i += 1;
      else if (lb > la) j += 1;
      else {
        i += 1;
        j += 1;
      }
    }
  }
  if (i < la || j < lb) edits += 1;
  return edits <= 1;
}

function isFlexibleNameMatch(candidateName, queryTokens) {
  if (queryTokens.length < 2) return false;
  const targetTokens = nameTokens(candidateName);
  if (targetTokens.length < queryTokens.length) return false;
  return queryTokens.every((qt) =>
    targetTokens.some((tt) => tt === qt || editDistanceAtMostOne(qt, tt)),
  );
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

function normalizeStoredCpfDigits(doc) {
  const digits = String(doc || '').replace(/\D/g, '');
  if (digits.length >= 9 && digits.length < 11) return digits.padStart(11, '0');
  return digits;
}

function extractCpfDigits(text) {
  const raw = String(text || '');
  const match = raw.match(/(?<!\d)(\d{3}[.\s]?\d{3}[.\s]?\d{3}[-\s]?\d{2})(?!\d)/);
  if (match) {
    return match[1].replace(/\D/g, '');
  }
  const allDigits = raw.replace(/\D/g, '');
  if (allDigits.length === 11) return allDigits;
  if (allDigits.length === 10 && isValidCpfDigits(`0${allDigits}`)) return `0${allDigits}`;
  return '';
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
    sessionTtlMs = 2 * 60 * 60 * 1000,
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

  _findMembersByQuery(rawQuery) {
    const cleaned = String(rawQuery || '')
      .replace(/^(adicionar|incluir|mais|tamb[eé]m|cpf|nome)\s*[:\-]?\s*/i, '')
      .trim();
    if (!cleaned) return [];
    const digits = extractCpfDigits(cleaned);
    const rows = this.store.all("SELECT * FROM members WHERE access_role = 'student'");

    let matches = [];
    if (digits.length === 11) {
      matches = rows.filter((m) => normalizeStoredCpfDigits(m.document) === digits);
    }
    // Exige ao menos 2 palavras relevantes para evitar enumeração por primeiro nome
    if (!matches.length) {
      const needle = stripAccents(cleaned);
      if (needle.includes(' ') && needle.length >= 6) {
        matches = rows.filter((m) => stripAccents(m.name) === needle);
        if (!matches.length) {
          const tokens = nameTokens(cleaned);
          if (tokens.length >= 2) {
            matches = rows.filter((m) => isFlexibleNameMatch(m.name, tokens));
          }
        }
      }
    }
    return matches;
  }

  _findBillableMembersByQuery(rawQuery) {
    return this._resolveBillableList(this._findMembersByQuery(rawQuery));
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
    const rows = this.store.all(
      `SELECT id, name, duration_days, price_cents
       FROM plans
       WHERE COALESCE(active, 1) = 1
         AND COALESCE(online_available, 1) = 1
         AND price_cents > 0
         AND duration_days > 1
       ORDER BY price_cents ASC, id ASC`,
    );
    return rows
      .filter((p) => {
        const label = stripAccents(p.name || '');
        return !label.includes('baby') && !label.includes('infantil') && !label.includes('kids');
      })
      .slice(0, 6);
  }

  _planRequiresClass(plan) {
    const label = stripAccents(plan?.name || '');
    return label.includes('nata') || label.includes('hidro') || label.includes('pilates');
  }

  _listOnlineClassesForPlan(plan) {
    const planLabel = stripAccents(plan?.name || '');
    const keyword = planLabel.includes('nata')
      ? 'nata'
      : planLabel.includes('hidro')
        ? 'hidro'
        : planLabel.includes('pilates')
          ? 'pilates'
          : '';
    const rows = this.store.all(
      `SELECT c.id, c.name, c.schedule, c.capacity,
              COALESCE(c.allow_new_enrollments, 1) AS allow_new_enrollments,
              COALESCE(c.online_enrollment_mode, 'auto') AS online_enrollment_mode,
              m.name AS modality_name,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
       FROM classes c
       LEFT JOIN modalities m ON m.id = c.modality_id
       WHERE COALESCE(c.active, 1) = 1
       ORDER BY c.name ASC, c.id ASC`,
    );
    return rows.filter((c) => {
      if (Number(c.allow_new_enrollments ?? 1) === 0) return false;
      if (c.online_enrollment_mode === 'reception_only') return false;
      const fullLabel = stripAccents(`${c.modality_name || ''} ${c.name || ''}`);
      if (KIDS_SWIM_REGEX.test(fullLabel)) return false;
      if (keyword && !fullLabel.includes(keyword)) return false;
      const cap = Number(c.capacity || 0);
      const enrolled = Number(c.enrolled_count || 0);
      if (cap > 0 && enrolled >= cap) return false;
      return true;
    });
  }

  _finalizeExistingMemberEnrollment({ phone, member, plan, chosenClass = null }) {
    this.store.run(
      "UPDATE members SET plan_id = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
      [plan.id, member.id],
    );
    if (chosenClass?.id) {
      this.store.run(
        'INSERT OR IGNORE INTO class_enrollments (class_id, member_id) VALUES (?, ?)',
        [chosenClass.id, member.id],
      );
    }
    const updated = this.store.get('SELECT * FROM members WHERE id = ?', [member.id]);
    const items = this._resolveBillableList(updated ? [updated] : []);
    if (!items.length) {
      this._sessions.delete(phone);
      const reply = 'Cadastro localizado! Para finalizar a matrícula, fale com nossa recepção.';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }
    this._setSession(phone, { kind: 'payment', items, pendingChargeId: null });
    const classNote = chosenClass ? ` na turma *${chosenClass.name}*` : '';
    const reply = this._buildPaymentMenuReply(
      items,
      `Matrícula adicionada para *${updated.name}* (*${plan.name}*${classNote})!`,
    );
    this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
    return { reply, requiresHuman: false };
  }

  async _handleEnrollmentFlow({ phone, userText, session, existingMember = null }) {
    if (KIDS_SWIM_REGEX.test(userText)) {
      this._sessions.delete(phone);
      this.pauseContact(phone, this.humanPauseMs);
      const reply = 'As modalidades de *Natação Baby* e *Natação Infantil* não possuem matrícula online automática por conta do controle de vagas por turma.\n\nPor favor, me informe a *idade da criança* e o *horário de preferência* — nossa recepção vai confirmar a disponibilidade e concluir com você por aqui!';
      this.recordChatMessage({
        phone,
        direction: 'out',
        senderType: 'bot',
        body: reply,
        needsHuman: true,
        handoffSummary: 'Matrícula Natação Baby/Infantil (somente recepção)',
      });
      return { reply, requiresHuman: true, reason: 'kids_swim_reception_only' };
    }

    if (!session) {
      if (!existingMember) {
        this._setSession(phone, {
          kind: 'enroll',
          step: 'ask_name',
          plans: [],
          chosenPlan: null,
          chosenClass: null,
          availableClasses: [],
          existingMember: null,
          fullName: null,
        });
        const reply = 'Ótimo! Vou fazer seu cadastro por aqui agora mesmo.\n\nPrimeiro, me informe seu *nome completo*:';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

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
        chosenClass: null,
        availableClasses: [],
        existingMember,
        fullName: existingMember.name || null,
      });
      const planLines = plans.map((p, idx) => `*${idx + 1}.* ${p.name} — *${formatBrl(p.price_cents)}*`).join('\n');
      const firstName = String(existingMember.name || 'Aluno').trim().split(/\s+/)[0];
      const reply = [
        `Encontrei o cadastro de *${firstName}*, mas ainda não há um plano vinculado. Escolha o número do plano para adicionar sua matrícula e pagar por aqui:`,
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

      if (this._planRequiresClass(chosen)) {
        const availableClasses = this._listOnlineClassesForPlan(chosen);
        if (!availableClasses.length) {
          this._sessions.delete(phone);
          this.pauseContact(phone, this.humanPauseMs);
          const reply = `As turmas de *${chosen.name}* estão sem vagas ou fechadas para matrícula online automática no momento.\n\nVou chamar nossa recepção para verificar disponibilidade com você por aqui!`;
          this.recordChatMessage({
            phone,
            direction: 'out',
            senderType: 'bot',
            body: reply,
            needsHuman: true,
            handoffSummary: `Turma indisponível online para ${chosen.name}`,
          });
          return { reply, requiresHuman: true, reason: 'class_unavailable_online' };
        }
        session.availableClasses = availableClasses;
        session.step = 'choose_class';
        this._setSession(phone, session);
        const classLines = availableClasses
          .map((c, cIdx) => {
            const cap = Number(c.capacity || 0);
            const spots = cap > 0 ? ` — ${Math.max(0, cap - Number(c.enrolled_count || 0))} vaga(s)` : '';
            const sched = c.schedule ? ` (${c.schedule})` : '';
            return `*${cIdx + 1}.* ${c.name}${sched}${spots}`;
          })
          .join('\n');
        const reply = [
          `Plano escolhido: *${chosen.name}* (*${formatBrl(chosen.price_cents)}*).`,
          '\nEscolha o número da turma / horário:',
          classLines,
          '\n_(Responda o número da turma ou *cancelar* para sair.)_',
        ].join('\n');
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      if (session.existingMember) {
        return this._finalizeExistingMemberEnrollment({
          phone,
          member: session.existingMember,
          plan: chosen,
        });
      }

      session.step = 'ask_name';
      this._setSession(phone, session);
      const reply = `Plano escolhido: *${chosen.name}* (*${formatBrl(chosen.price_cents)}*).\n\nAgora me informe seu *nome completo*:`;
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'choose_class') {
      const idx = Number(String(userText).trim()) - 1;
      const chosenClass =
        Number.isInteger(idx) && idx >= 0 && idx < (session.availableClasses || []).length
          ? session.availableClasses[idx]
          : null;
      if (!chosenClass) {
        const reply = `Responda apenas o número de *1 a ${session.availableClasses.length}* para escolher a turma, ou *cancelar* para sair.`;
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      session.chosenClass = chosenClass;
      if (session.existingMember) {
        return this._finalizeExistingMemberEnrollment({
          phone,
          member: session.existingMember,
          plan: session.chosenPlan,
          chosenClass,
        });
      }
      session.step = 'ask_name';
      this._setSession(phone, session);
      const reply = `Turma escolhida: *${chosenClass.name}*.\n\nAgora me informe seu *nome completo*:`;
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
          });
        } else {
          const ins = this.store.run(
            "INSERT INTO members (name, document, phone, status, access_role) VALUES (?, ?, ?, 'pending', 'student')",
            [session.fullName, formattedCpf, phone],
          );
          member = this.store.get('SELECT * FROM members WHERE id = ?', [ins.lastInsertRowid]);
        }
      }

      const items = this._resolveBillableList([member]);
      if (items.length > 0) {
        this._setSession(phone, { kind: 'payment', items, pendingChargeId: null });
        const reply = this._buildPaymentMenuReply(
          items,
          `Cadastro localizado para *${member.name}*!`,
        );
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      const plans = this._listOnlinePlans();
      if (!plans.length) {
        this._sessions.delete(phone);
        const reply = `Cadastro pronto para *${member.name}*! Nossa recepção pode vincular sua modalidade/plano por aqui.`;
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      this._setSession(phone, {
        kind: 'enroll',
        step: 'choose_plan',
        plans,
        chosenPlan: null,
        chosenClass: null,
        availableClasses: [],
        existingMember: member,
        fullName: member.name,
      });
      const planLines = plans.map((p, idx) => `*${idx + 1}.* ${p.name} — *${formatBrl(p.price_cents)}*`).join('\n');
      const reply = [
        `Cadastro pronto para *${member.name}*! Agora escolha o número da modalidade/plano que deseja adicionar (seguindo as regras de vagas):`,
        '\nEscolha o número do plano desejado:',
        planLines,
        '\n_(Responda o número do plano ou *cancelar* se quiser apenas manter o cadastro.)_',
      ].join('\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    return null;
  }

  async handleMessage({ phone, userText, settings = this.store.getSettings?.() || {} }) {
    const existing = this._getSession(phone);
    const wantsPayment = PAYMENT_INTENT_REGEX.test(userText);
    const wantsEnroll = ENROLLMENT_INTENT_REGEX.test(userText);
    const directCpf = !existing ? extractCpfDigits(userText) : '';
    const hasDirectValidCpf = Boolean(directCpf && isValidCpfDigits(directCpf));

    if (!existing && !wantsPayment && !wantsEnroll && !hasDirectValidCpf) return null;

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
      const directItems = hasDirectValidCpf ? this._findBillableMembersByQuery(directCpf) : [];
      if (hasDirectValidCpf && !wantsPayment && !directItems.length) return null;
      const ownItems = directItems.length > 0 ? directItems : this._findBillableMembersByPhone(phone);
      if (ownItems.length === 0) {
        const phoneMembers = this.store
          .all("SELECT * FROM members WHERE access_role = 'student'")
          .filter((m) => normalizeBrPhone(m.phone) === phone);
        if (phoneMembers.length === 1) {
          return this._handleEnrollmentFlow({ phone, userText: '', session: null, existingMember: phoneMembers[0] });
        }
      }
      const session = this._setSession(phone, { kind: 'payment', items: ownItems, pendingChargeId: null });
      const reply = ownItems.length > 0
        ? this._buildPaymentMenuReply(ownItems, 'Encontrei seu cadastro para pagamento:')
        : 'Claro! Para gerar o pagamento pelo Mercado Pago, informe o *CPF (11 dígitos)* ou o *nome completo* do aluno.\n\n_(Se quiser pagar para mais de uma pessoa tudo junto, é só enviar um por vez!)_';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false, session };
    }

    const matchedMembers = this._findMembersByQuery(userText);
    const found = this._resolveBillableList(matchedMembers);
    if (!found.length) {
      if (matchedMembers.length === 1) {
        return this._handleEnrollmentFlow({ phone, userText: '', session: null, existingMember: matchedMembers[0] });
      }
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
