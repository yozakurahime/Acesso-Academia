import { normalizeBrPhone, areEquivalentBrPhones } from './whatsappService.js';

const PAYMENT_ACTION_REGEX = /^(?:pix|pagar|pagamento|renovar|renova[cç][aã]o|mensalidade|link\s+de\s+pagamento)$|\b(?:(?:quero|gostaria\s+de|preciso|queria|vou|vamos|me\s+manda|manda|envia|enviar|gera|gerar|fazer|realizar)\s+(?:o\s+|a\s+|meu\s+|minha\s+|um\s+|uma\s+)?(?:pagamento|pagar|mensalidade|renovar|renova[cç][aã]o|pix|link(?:\s+de\s+pagamento)?|c[oó]digo\s+pix|qr\s*code)|pagar\s+(?:a\s+|minha\s+|o\s+|meu\s+)?(?:mensalidade|plano|parcela|fatura|renova[cç][aã]o)|pagar\s+(?:agora|por\s+aqui|online|via\s+pix|no\s+pix|no\s+cart[aã]o)|renovar\s+(?:a\s+|minha\s+|o\s+|meu\s+)?(?:mensalidade|plano|matr[ií]cula)|link\s+de\s+pagamento)\b/i;
const PAYMENT_NON_ACTION_REGEX = /\b(?:consigo\s+(?:treinar|ir|entrar|passar)|posso\s+(?:treinar|ir|entrar|passar)|ainda\s+(?:consigo|posso)|libera(?:r|do|da)?\s+(?:a\s+)?catraca|venceu|vencid[oa]|atrasad[oa]|toler[âa]ncia|s[óo]\s+(?:consigo|posso|vou)\s+pagar|pagar\s+(?:amanh[ãa]|depois|outro\s+dia|semana\s+que\s+vem|m[êe]s\s+que\s+vem|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo|dia\s+\d+)|qual\s+(?:[ée]\s+)?(?:o\s+)?valor|quanto\s+(?:custa|[ée]|fica|t[áa]|esta|est[áa])|(?:o\s+)?valor\s+(?:da\s+|do\s+|de\s+)?(?:mensalidade|plano|matr[ií]cula|di[aá]ria|parcela|academia)|pre[çc]o\s+(?:da\s+|do\s+|de\s+)?(?:mensalidade|plano|matr[ií]cula|di[aá]ria|academia)|j[aá]\s+(?:realizei|fiz|efetuei|mandei|enviei|paguei)(?:\s+(?:o|a|meu|minha))?(?:\s+(?:pagamento|pix|mensalidade|comprovante))?|comprovante(?:\s+de\s+pagamento)?|quais\s+(?:s[ãa]o\s+)?(?:as\s+)?formas|aceita(?:m)?\s+(?:pix|cart[aã]o|dinheiro|boleto)|como\s+funciona)\b/i;
const NON_LOOKUP_PHRASE_REGEX = /\b(?:hoje|amanha|ontem|posso|consigo|treinar|entao|quando|quanto|qual|quais|como|onde|porque|ainda|horario|funciona|abre|fecha|venceu|vencida|vencido|parcela|atraso|atrasado|ir|entrar|passar|valor|preco|aceita|aceitam|obrigado|obrigada|valeu|bom dia|boa tarde|boa noite|ja|tenho|cadastro|matricula|mensalidade|plano|pix|cartao|dinheiro|boleto|comprovante|realizei|paguei|pagamento|pagar|trancar|pausar|congelar|cirurgia|atestado|recepcao|atendente|professor|personal|piscina|natacao|hidro|pilates|musculacao|danca|capoeira|jiu|sabado|domingo|segunda|terca|quarta|quinta|sexta|feriado|ajuda|duvida|informacao|sim|nao|certo|beleza|tudo bem|ola|oi)\b/;
const ENROLLMENT_INTENT_REGEX = /\b(?:(?:quero|gostaria\s+de|vamos|preciso|posso|queria)\s+(?:me\s+)?(?:matricular|cadastrar)|(?:fazer|fechar|concluir|realizar|abrir|iniciar|nova)\s+(?:a\s+|uma\s+)?(?:matr[ií]cula|cadastro|inscri[cç][aã]o)|me\s+(?:matricular|cadastrar)|matricular\s+(?:meu|minha|o|a|um|uma|ele|ela))\b/i;
const ALREADY_REGISTERED_REGEX = /\b(?:j[aá]\s+(?:tenho|fiz|possuo)\s+(?:um\s+)?cadastro|j[aá]\s+(?:sou|estou)\s+(?:cadastrad[oa]|alun[oa]|matriculad[oa])|tenho\s+cadastro|sou\s+(?:cadastrad[oa]|alun[oa]))\b/i;
const FREEZE_INTENT_REGEX = /\b(?:(?:quero|gostaria\s+de|preciso|queria|pode|poderia|posso|consigo|tem\s+como|d[aá]\s+pr?a|vou|vamos|faz|fazer|pedi\s+(?:pra|para))\s+(?:trancar|pausar|congelar)(?:\s+(?:a\s+|minha\s+|o\s+|meu\s+|por\s+)?(?:matr[ií]cula|plano|academia|cirurgia|viagem|sa[uú]de|um\s+tempo|\d+\s+dias?))?|(?:tranca|trancar|pausa|pausar|congela|congelar)\s+(?:(?:a\s+|minha\s+|o\s+|meu\s+)?(?:matr[ií]cula|plano|academia)|por\s+(?:cirurgia|viagem|sa[uú]de|motivo))|trancamento(?:\s+(?:da|de)\s+(?:matr[ií]cula|plano))?)\b/i;
const FREEZE_NON_ACTION_REGEX = /\b(?:como\s+funciona|tem\s+taxa|cobra\s+taxa|quanto\s+(?:custa|[ée])|qual\s+(?:[ée]\s+)?a\s+regra)\b/i;
const KIDS_SWIM_REGEX = /\b(nata[cç][aã]o\s*(?:baby|infantil|kids|crian[cç]a)|baby|infantil)\b/i;
const FLOW_CANCEL_REGEX = /^(cancelar|sair|voltar|depois|n[aã]o\s+quero)$/i;
const CONFIRM_YES_REGEX = /^(1|sim|s|confirmar|confirmo|certo|ok|correto|isso)$/i;
const CONFIRM_FIX_REGEX = /^(2|n[aã]o|n|corrigir|alterar|editar|errado|refazer)$/i;
const EMAIL_SKIP_REGEX = /^(pular|nao|n[aã]o|n[aã]o\s+tenho|sem\s+e-?mail|depois)$/i;
const SIMPLE_EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ADD_ANOTHER_PERSON_REGEX = /^(3|mais|outra|outro|cadastrar\s+outr[ao]|outr[ao]\s+pessoa|nova\s+pessoa|adicionar\s+pessoa|mais\s+uma?)$/i;
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

function looksLikeMemberLookupQuery(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const digits = raw.replace(/\D/g, '');
  if (digits.length >= 6) return true;
  if (raw.includes('?')) return false;
  const normalized = stripAccents(raw);
  if (!normalized || NON_LOOKUP_PHRASE_REGEX.test(normalized)) return false;
  const words = normalized.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= 6;
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
    const matches = rows.filter((m) => areEquivalentBrPhones(m.phone, phone));
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
      '• Responda *1* para gerar o *Pix Copia e Cola* *(mais rápido)*',
      '• Responda *2* para *Cartão / Link de pagamento*',
      '• Responda *3* para *cadastrar outra pessoa* e incluir junto',
      '• Ou envie o *CPF ou nome completo* de alguém já cadastrado para incluir',
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
      });
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

  _mergePaymentItems(existingItems = [], newItems = []) {
    const merged = [...(existingItems || [])];
    for (const item of newItems || []) {
      if (!merged.some((m) => m.member_id === item.member_id)) {
        merged.push(item);
      }
    }
    return merged;
  }

  _startAnotherEnrollmentSession(phone, paymentItems = [], prefix = '') {
    this._setSession(phone, {
      kind: 'enroll',
      step: 'ask_name',
      plans: [],
      chosenPlan: null,
      chosenClass: null,
      availableClasses: [],
      existingMember: null,
      fullName: null,
      pendingCpfDigits: null,
      pendingCpfFormatted: null,
      existingByCpf: null,
      paymentItems: [...(paymentItems || [])],
    });
    const prompt = prefix
      ? `${prefix}\n\nInforme o *nome completo* da próxima pessoa:`
      : 'Ótimo! Vamos cadastrar a próxima pessoa.\n\nInforme o *nome completo*:';
    this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: prompt });
    return { reply: prompt, requiresHuman: false };
  }

  _finalizeExistingMemberEnrollment({ phone, member, plan, chosenClass = null, existingPaymentItems = [] }) {
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
    const newItems = this._resolveBillableList(updated ? [updated] : []);
    const items = this._mergePaymentItems(existingPaymentItems, newItems);
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
        const phoneMembers = this.store
          .all("SELECT * FROM members WHERE access_role = 'student'")
          .filter((m) => areEquivalentBrPhones(m.phone, phone));
        if (phoneMembers.length >= 1) {
          const billable = this._resolveBillableList(phoneMembers);
          if (billable.length > 0) {
            this._setSession(phone, { kind: 'payment', items: billable, pendingChargeId: null });
            const reply = this._buildPaymentMenuReply(
              billable,
              phoneMembers.length === 1
                ? 'Encontrei seu cadastro já vinculado a um plano:'
                : 'Encontrei cadastros já vinculados a este WhatsApp:',
            );
            this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
            return { reply, requiresHuman: false };
          }
          if (phoneMembers.length === 1) {
            existingMember = phoneMembers[0];
          }
        }
      }

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
          pendingCpfDigits: null,
          pendingCpfFormatted: null,
          existingByCpf: null,
          paymentItems: [],
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
        paymentItems: [],
      });
      const planLines = plans.map((p, idx) => `*${idx + 1}.* ${p.name} — *${formatBrl(p.price_cents)}*`).join('\n');
      const firstName = String(existingMember.name || 'Aluno').trim().split(/\s+/)[0];
      const reply = [
        `Encontrei o cadastro de *${firstName}*, mas ainda não há um plano vinculado. Escolha o número do plano para adicionar sua matrícula e pagar por aqui:`,
        '\nEscolha o número do plano desejado:',
        planLines,
        '\n_(Responda o número do plano, *mais* para cadastrar outra pessoa ou *cancelar* para sair.)_',
      ].join('\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'choose_plan') {
      if (ADD_ANOTHER_PERSON_REGEX.test(String(userText).trim())) {
        const savedName = session.existingMember?.name || session.fullName || 'o aluno';
        return this._startAnotherEnrollmentSession(
          phone,
          session.paymentItems || [],
          `Cadastro de *${savedName}* mantido! Vamos cadastrar a próxima pessoa.`,
        );
      }

      const idx = Number(String(userText).trim()) - 1;
      const chosen = Number.isInteger(idx) && idx >= 0 && idx < session.plans.length ? session.plans[idx] : null;
      if (!chosen) {
        const reply = `Responda apenas o número de *1 a ${session.plans.length}* para escolher o plano, *mais* para cadastrar outra pessoa ou *cancelar* para sair.`;
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
          existingPaymentItems: session.paymentItems || [],
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
          existingPaymentItems: session.paymentItems || [],
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
      const cpfInName = extractCpfDigits(name);
      if (cpfInName.length === 11 && isValidCpfDigits(cpfInName)) {
        const formattedCpf = formatCpfDigits(cpfInName);
        const existingByCpf = this.store
          .all("SELECT * FROM members WHERE access_role = 'student'")
          .find((m) => normalizeStoredCpfDigits(m.document) === cpfInName) || null;
        if (existingByCpf) {
          session.pendingCpfDigits = cpfInName;
          session.pendingCpfFormatted = formattedCpf;
          session.existingByCpf = existingByCpf;
          session.fullName = existingByCpf.name;
          session.pendingEmail = existingByCpf.email ? String(existingByCpf.email).trim() : null;
          if (session.pendingEmail) {
            session.step = 'confirm_data';
            this._setSession(phone, session);
            const reply = [
              'Encontrei um cadastro com este CPF. Confira os dados:',
              `\n• *Nome:* ${existingByCpf.name}`,
              `• *CPF:* ${formattedCpf}`,
              `• *E-mail:* ${session.pendingEmail}`,
              '\n• Responda *1* ou *sim* para confirmar e continuar',
              '• Responda *2* ou *corrigir* para digitar novamente',
            ].join('\n');
            this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
            return { reply, requiresHuman: false };
          }
          session.step = 'ask_email';
          this._setSession(phone, session);
          const reply = `Encontrei o cadastro de *${existingByCpf.name}*! Agora informe seu *e-mail* para receber o comprovante do pagamento (ou responda *pular*):`;
          this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
          return { reply, requiresHuman: false };
        }
        const reply = 'Não encontrei cadastro com esse CPF. Por favor, informe seu *nome e sobrenome completos* (sem números):';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      const strippedName = stripAccents(name);
      if (ALREADY_REGISTERED_REGEX.test(strippedName)) {
        const reply = 'Se você já tem cadastro, me envie seu *CPF (11 dígitos)* para eu localizar, ou informe seu *nome e sobrenome completos*:';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      const isInvalidName =
        name.length < 5
        || !name.includes(' ')
        || /\d/.test(name)
        || /[?!@#$%^&*=+]/.test(name)
        || NON_LOOKUP_PHRASE_REGEX.test(strippedName)
        || PAYMENT_ACTION_REGEX.test(name)
        || PAYMENT_NON_ACTION_REGEX.test(name)
        || ENROLLMENT_INTENT_REGEX.test(name)
        || nameTokens(name).length < 2;

      if (isInvalidName) {
        const reply = 'Por favor, informe seu *nome e sobrenome completos* (sem números):';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      session.fullName = name;
      session.step = 'ask_cpf';
      this._setSession(phone, session);
      const reply = `Certo, *${name}*! Agora informe o *CPF (11 dígitos)*:`;
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
        .find((m) => String(m.document || '').replace(/\D/g, '') === digits) || null;

      session.pendingCpfDigits = digits;
      session.pendingCpfFormatted = formattedCpf;
      session.existingByCpf = existingByCpf;
      session.pendingEmail = existingByCpf?.email ? String(existingByCpf.email).trim() : null;

      if (existingByCpf && session.pendingEmail) {
        session.step = 'confirm_data';
        this._setSession(phone, session);
        const reply = [
          'Encontrei um cadastro com este CPF. Confira os dados:',
          `\n• *Nome:* ${existingByCpf.name}`,
          `• *CPF:* ${formattedCpf}`,
          `• *E-mail:* ${session.pendingEmail}`,
          '\n• Responda *1* ou *sim* para confirmar e continuar',
          '• Responda *2* ou *corrigir* para digitar novamente',
        ].join('\n');
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      session.step = 'ask_email';
      this._setSession(phone, session);
      const reply = 'Agora informe seu *e-mail* para receber o comprovante do pagamento (ou responda *pular* se não quiser informar):';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'ask_email') {
      const rawEmail = String(userText || '').trim();
      if (EMAIL_SKIP_REGEX.test(rawEmail)) {
        session.pendingEmail = null;
      } else if (SIMPLE_EMAIL_REGEX.test(rawEmail)) {
        session.pendingEmail = rawEmail.toLowerCase();
      } else {
        const reply = 'E-mail inválido. Digite um e-mail válido (ex: nome@gmail.com) ou responda *pular*:';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      session.step = 'confirm_data';
      this._setSession(phone, session);
      const displayName = session.existingByCpf ? session.existingByCpf.name : session.fullName;
      const header = session.existingByCpf
        ? 'Encontrei um cadastro com este CPF. Confira os dados:'
        : 'Confira se os dados estão corretos:';
      const reply = [
        header,
        `\n• *Nome:* ${displayName}`,
        `• *CPF:* ${session.pendingCpfFormatted}`,
        `• *E-mail:* ${session.pendingEmail || 'Não informado'}`,
        '\n• Responda *1* ou *sim* para confirmar e continuar',
        '• Responda *2* ou *corrigir* para digitar novamente',
      ].join('\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (session.step === 'confirm_data') {
      const answer = String(userText || '').trim();
      if (CONFIRM_FIX_REGEX.test(answer)) {
        session.step = 'ask_name';
        session.fullName = null;
        session.pendingCpfDigits = null;
        session.pendingCpfFormatted = null;
        session.pendingEmail = null;
        session.existingByCpf = null;
        this._setSession(phone, session);
        const reply = 'Tudo bem! Vamos corrigir os dados.\n\nInforme o *nome completo*:';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }
      if (!CONFIRM_YES_REGEX.test(answer)) {
        const reply = 'Responda *1* (ou *sim*) para confirmar os dados, ou *2* (ou *corrigir*) para digitar novamente.';
        this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
        return { reply, requiresHuman: false };
      }

      let member = session.existingByCpf || null;
      if (!member) {
        if (this.accessService?.createMember) {
          member = await this.accessService.createMember({
            name: session.fullName,
            document: session.pendingCpfFormatted,
            phone,
            email: session.pendingEmail || null,
          });
        } else {
          const ins = this.store.run(
            "INSERT INTO members (name, document, phone, email, status, access_role) VALUES (?, ?, ?, ?, 'pending', 'student')",
            [session.fullName, session.pendingCpfFormatted, phone, session.pendingEmail || null],
          );
          member = this.store.get('SELECT * FROM members WHERE id = ?', [ins.lastInsertRowid]);
        }
      } else if (session.pendingEmail && !member.email) {
        this.store.run(
          "UPDATE members SET email = ?, updated_at = datetime('now', 'localtime') WHERE id = ?",
          [session.pendingEmail, member.id],
        );
        member = this.store.get('SELECT * FROM members WHERE id = ?', [member.id]);
      }

      const newItems = this._resolveBillableList([member]);
      if (newItems.length > 0) {
        const items = this._mergePaymentItems(session.paymentItems || [], newItems);
        this._setSession(phone, { kind: 'payment', items, pendingChargeId: null });
        const reply = this._buildPaymentMenuReply(
          items,
          `Cadastro confirmado para *${member.name}*!`,
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
        pendingCpfDigits: null,
        pendingCpfFormatted: null,
        existingByCpf: null,
        paymentItems: session.paymentItems || [],
      });
      const planLines = plans.map((p, idx) => `*${idx + 1}.* ${p.name} — *${formatBrl(p.price_cents)}*`).join('\n');
      const reply = [
        `Cadastro pronto para *${member.name}*! Agora escolha o número da modalidade/plano que deseja adicionar (seguindo as regras de vagas):`,
        '\nEscolha o número do plano desejado:',
        planLines,
        '\n_(Responda o número do plano, *mais* para cadastrar outra pessoa ou *cancelar* para sair.)_',
      ].join('\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    return null;
  }

  async _executeFreezeForMember({ phone, member, days = null, reason = null }) {
    try {
      const result = await this.accessService.freezeMember(
        member.id,
        { days, reason: reason || 'Trancamento via WhatsApp' },
        { backgroundSync: true },
      );
      this._sessions.delete(phone);
      const frozenUntil = result?.member?.frozen_until;
      const untilText = frozenUntil && frozenUntil !== '9999-12-31'
        ? `até *${frozenUntil.split('-').reverse().join('/')}*`
        : 'por tempo indeterminado (até você pedir para destrancar na recepção ou por aqui)';
      const reply = [
        `✅ Matrícula de *${member.name}* trancada com sucesso ${untilText}!`,
        'Não é necessário enviar atestado médico.',
      ].join('\n\n');
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false, member: result.member };
    } catch (err) {
      this._sessions.delete(phone);
      const msg = String(err?.message || 'Não foi possível trancar a matrícula agora.');
      const reply = `${msg}\n\n_(Não exigimos atestado médico para trancamento. Se precisar de ajuda da recepção, responda *atendente*.)_`;
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }
  }

  async _handleFreezeFlow({ phone, userText, session }) {
    if (!this.accessService) return null;

    if (!session) {
      const daysMatch = String(userText || '').match(/\b(\d{1,3})\s*dias?\b/i);
      const days = daysMatch ? Math.max(1, Number(daysMatch[1])) : null;
      const cleanReason = String(userText || '').trim().slice(0, 120) || 'Trancamento via WhatsApp';

      const phoneMembers = this.store
        .all("SELECT * FROM members WHERE access_role = 'student'")
        .filter((m) => areEquivalentBrPhones(m.phone, phone));

      if (phoneMembers.length === 1) {
        return this._executeFreezeForMember({ phone, member: phoneMembers[0], days, reason: cleanReason });
      }

      this._setSession(phone, {
        kind: 'freeze',
        step: 'awaiting_cpf',
        days,
        reason: cleanReason,
      });
      const reply = 'Claro! Não precisa de atestado médico para trancar. Para localizar seu cadastro e realizar o trancamento agora, informe seu *CPF (11 dígitos)* (ou responda *cancelar*).';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (!looksLikeMemberLookupQuery(userText)) {
      this._sessions.delete(phone);
      return null;
    }

    const cpfDigits = extractCpfDigits(userText);
    if (!cpfDigits || !isValidCpfDigits(cpfDigits)) {
      const reply = 'Por favor, informe um *CPF válido (11 dígitos)* para confirmar seu cadastro e trancar a matrícula, ou responda *cancelar*.';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    const matched = this.store
      .all("SELECT * FROM members WHERE access_role = 'student'")
      .filter((m) => String(m.document || '').replace(/\D/g, '') === cpfDigits);

    if (!matched.length) {
      const reply = 'Não encontrei nenhum aluno cadastrado com esse CPF. Confira os 11 dígitos e envie novamente, ou responda *cancelar*.';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    return this._executeFreezeForMember({
      phone,
      member: matched[0],
      days: session.days || null,
      reason: session.reason || 'Trancamento via WhatsApp',
    });
  }

  async handleMessage({ phone, userText, settings = this.store.getSettings?.() || {} }) {
    const existing = this._getSession(phone);
    const wantsPayment = PAYMENT_ACTION_REGEX.test(userText) && !PAYMENT_NON_ACTION_REGEX.test(userText);
    const wantsEnroll = ENROLLMENT_INTENT_REGEX.test(userText);
    const wantsFreeze = FREEZE_INTENT_REGEX.test(userText) && !FREEZE_NON_ACTION_REGEX.test(userText);
    const directCpf = !existing ? extractCpfDigits(userText) : '';
    const hasDirectValidCpf = Boolean(directCpf && isValidCpfDigits(directCpf));

    if (!existing && !wantsPayment && !wantsEnroll && !wantsFreeze && !hasDirectValidCpf) return null;

    if (existing && FLOW_CANCEL_REGEX.test(userText)) {
      this._sessions.delete(phone);
      const reply = 'Certo, cancelei o fluxo por aqui. Se precisar de outra ajuda, é só chamar!';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
    }

    if (existing?.kind === 'freeze' || (wantsFreeze && !wantsPayment && !wantsEnroll && existing?.kind !== 'enroll')) {
      return this._handleFreezeFlow({ phone, userText, session: existing?.kind === 'freeze' ? existing : null });
    }

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

    if (existing?.kind === 'payment' && ADD_ANOTHER_PERSON_REGEX.test(String(userText).trim())) {
      return this._startAnotherEnrollmentSession(phone, existing.items || []);
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
          .filter((m) => areEquivalentBrPhones(m.phone, phone));
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

    if (!looksLikeMemberLookupQuery(userText)) {
      if (existing.items.length === 0) {
        this._sessions.delete(phone);
      }
      return null;
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
