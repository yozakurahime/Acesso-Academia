import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBrPhone, brPhoneVariants, areEquivalentBrPhones } from './whatsappService.js';
import { OnlineSalesBotService, formatBrl } from './onlineSalesBotService.js';
import { resolveGymNotices } from './fitnessProgress.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTEXT_PATH = path.resolve(__dirname, '..', 'config', 'defaultBotContext.txt');

export const CONTEXT_MISSING_HANDOFF_MARKER = '[[HUMAN_HANDOFF_CONTEXT_MISSING]]';

const HUMAN_REQUEST_REGEX = /\b(atendente|humano|pessoa\s+real|falar\s+com\s+(?:algu[eé]m|atendente|recep[cç][aã]o|gerente|dono)|chamar\s+atendente|suporte\s+humano)\b/i;
const LLM_HANDOFF_PROMISE_REGEX = /\b(?:(?:vou|estou|j[aá])\s+(?:encaminhar|encaminhando|encaminhei|passar|passando|passei|transferir|transferindo|chamar|chamando)\b[^.\n]*\b(?:recep[cç][aã]o|equipe|atendente|humano)|(?:nossa\s+)?(?:recep[cç][aã]o|equipe)\s+(?:vai|ir[aá]|precisa)\s+(?:confirmar|verificar|conferir|responder|concluir|assumir|te\s+chamar|te\s+atender))\b/i;

const DEFAULT_PLAYBOOKS = [
  'Mensalidade: Quando perguntarem valor da mensalidade ou preço de plano, responda com os valores que existirem no contexto. Se não houver valor no contexto, encaminhe para o atendimento humano.',
  'Modalidades: Quando perguntarem modalidades, responda com lista objetiva (nome, frequência, público e observações) priorizando clareza.',
  'Matrícula Online: Para todas as modalidades abertas (Musculação, Pilates, Dança, Jiu-Jitsu, Hidroginástica, Natação Adulto e Combos), oriente que o cliente pode escolher a modalidade/turma, fazer o cadastro, enviar a foto do Face ID e pagar via PIX diretamente pelo link https://sistema.academiaoxigenio.com/matricula.html (ou concluir por aqui / com atendente humano).',
  'Regras de Vagas por Turma: Hidroginástica tem limite máximo de 15 alunos por horário (matrícula online automática conforme vagas); Natação Adulto tem limite máximo de 6 alunos por horário (matrícula online automática conforme vagas); Pilates Seg/Qua/Sex 07:00 (Prof. Gustavo) está aberta para novas matrículas e Pilates Seg/Qua/Sex 18:00 está FECHADO para novas matrículas (somente alunos já matriculados continuam); Natação Infantil e Baby NÃO permitem matrícula ou confirmação automática de vaga online — sempre informe que a vaga precisa ser confirmada pela recepção/professor, colete idade da criança e horário de preferência, e encaminhe para atendimento humano.',
  'Tolerância e Personal Trainer: Não há bloqueio da catraca no próprio dia do vencimento — existe um período de tolerância após o vencimento conforme a regra vigente da academia (sem inventar números não confirmados). Personal Trainer é contratado à parte diretamente com o profissional (não está incluso nos planos da academia).',
  'Trancamento de Matrícula: NÃO exigimos atestado médico para trancar matrícula. O próprio bot realiza o trancamento pelo WhatsApp (limite de 1 trancamento por mês). Nunca peça atestado médico ou encaminhe para a recepção por falta de atestado.',
  'Objeções: Quando houver indecisão (tempo, preço, distância), responda com empatia, destaque benefícios práticos e convide para conhecer a academia.',
].join('\n');

function resolveBrazilNowInfo(now = new Date()) {
  const timezone = 'America/Sao_Paulo';
  const dateBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  }).format(now);
  const weekday = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    weekday: 'long',
  }).format(now);
  const timeBR = new Intl.DateTimeFormat('pt-BR', {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);
  return { timezone, dateBR, weekday, timeBR };
}

function sanitizeReply(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export class WhatsappBotService {
  constructor(store, {
    contextFilePath = DEFAULT_CONTEXT_PATH,
    fetchFn = fetch,
    gatewayService = null,
    accessService = null,
    humanPauseMs = 4 * 60 * 60 * 1000,
    ownerTakeoverPauseMs = 30 * 60 * 1000,
    historyMaxTurns = 10,
    historyTtlMs = 6 * 60 * 60 * 1000,
    paymentSessionTtlMs = 2 * 60 * 60 * 1000,
  } = {}) {
    this.store = store;
    this.contextFilePath = contextFilePath;
    this.fetchFn = fetchFn;
    this.humanPauseMs = humanPauseMs;
    this.ownerTakeoverPauseMs = ownerTakeoverPauseMs;
    this.historyMaxTurns = historyMaxTurns;
    this.historyTtlMs = historyTtlMs;
    this._pausedUntil = new Map();
    this._histories = new Map();
    this._cachedFileText = null;
    this._cachedFileMtimeMs = 0;
    this.onlineSalesBot = new OnlineSalesBotService(store, {
      gatewayService,
      accessService,
      recordChatMessage: (payload) => this.recordChatMessage(payload),
      pauseContact: (phone, ms) => this.pauseContact(phone, ms),
      humanPauseMs,
      sessionTtlMs: paymentSessionTtlMs,
    });
  }

  setGatewayService(gatewayService) {
    this.onlineSalesBot.setGatewayService(gatewayService);
  }

  setAccessService(accessService) {
    this.onlineSalesBot.setAccessService(accessService);
  }

  _resolveChatPhone(phone) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return null;
    const variants = brPhoneVariants(normalized);
    if (variants.length > 1) {
      try {
        const existing = this.store.get(
          `SELECT phone FROM whatsapp_chats
           WHERE phone IN (${variants.map(() => '?').join(', ')})
           ORDER BY CASE WHEN phone = ? THEN 0 ELSE 1 END, last_message_at DESC
           LIMIT 1`,
          [...variants, normalized],
        );
        if (existing?.phone) return existing.phone;
      } catch {
        // ignore if table not present
      }
    }
    return normalized;
  }

  isPaused(phone, nowMs = Date.now()) {
    const normalized = this._resolveChatPhone(phone);
    if (!normalized) return false;
    try {
      const variants = brPhoneVariants(normalized);
      const row = this.store.get(
        `SELECT bot_paused, bot_paused_until FROM whatsapp_chats
         WHERE phone IN (${variants.map(() => '?').join(', ')})
         ORDER BY CASE WHEN phone = ? THEN 0 ELSE 1 END, last_message_at DESC
         LIMIT 1`,
        [...variants, normalized],
      );
      if (Number(row?.bot_paused) === 1) {
        const dbUntil = Number(row?.bot_paused_until || 0);
        if (dbUntil > 0 && nowMs >= dbUntil) {
          this.resumeContact(normalized);
          return false;
        }
        return true;
      }
    } catch {
      // ignore if table not present
    }
    for (const v of brPhoneVariants(normalized)) {
      const until = this._pausedUntil.get(v);
      if (!until) continue;
      if (nowMs >= until) {
        this._pausedUntil.delete(v);
      } else {
        return true;
      }
    }
    return false;
  }

  pauseContact(phone, durationMs = this.humanPauseMs, nowMs = Date.now()) {
    const normalized = this._resolveChatPhone(phone);
    if (!normalized) return;
    const until = nowMs + Math.max(1000, Number(durationMs) || this.humanPauseMs);
    this._pausedUntil.set(normalized, until);
    if (this._pausedUntil.size > 1000) {
      this._pausedUntil.delete(this._pausedUntil.keys().next().value);
    }
    try {
      this.store.run(
        `INSERT INTO whatsapp_chats (phone, bot_paused, bot_paused_until, last_message_at)
         VALUES (?, 1, ?, datetime('now', 'localtime'))
         ON CONFLICT(phone) DO UPDATE SET bot_paused = 1, bot_paused_until = excluded.bot_paused_until`,
        [normalized, until],
      );
    } catch {}
  }

  resumeContact(phone) {
    const normalized = this._resolveChatPhone(phone);
    if (!normalized) return;
    const variants = brPhoneVariants(normalized);
    for (const v of variants) this._pausedUntil.delete(v);
    try {
      this.store.run(
        `UPDATE whatsapp_chats SET bot_paused = 0, bot_paused_until = NULL, needs_human = 0, handoff_summary = NULL
         WHERE phone IN (${variants.map(() => '?').join(', ')})`,
        variants,
      );
    } catch {}
  }

  markHumanTakeover(phone, nowMs = Date.now()) {
    this.pauseContact(phone, this.ownerTakeoverPauseMs, nowMs);
  }

  _findMembersForExactPhone(normalizedPhone) {
    if (!normalizedPhone) return [];
    try {
      const candidates = this.store.all(
        `SELECT m.id, m.name, m.phone, m.status, m.valid_until, p.name AS plan_name
         FROM members m
         LEFT JOIN plans p ON p.id = m.plan_id
         WHERE replace(replace(replace(replace(COALESCE(m.phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?
         ORDER BY m.id DESC`,
        [normalizedPhone.slice(-8)],
      );
      return candidates.filter((m) => areEquivalentBrPhones(m.phone, normalizedPhone));
    } catch {
      return [];
    }
  }

  _findMemberForPhone(normalizedPhone) {
    return this._findMembersForExactPhone(normalizedPhone)[0] || null;
  }

  recordChatMessage({
    phone,
    direction = 'in',
    senderType = 'customer',
    body = '',
    mediaType = null,
    mediaUrl = null,
    contactName = null,
    needsHuman = false,
    handoffSummary = null,
  } = {}) {
    const normalized = this._resolveChatPhone(phone);
    const cleanBody = String(body || '').trim();
    if (!normalized || (!cleanBody && !mediaUrl)) return null;

    const previewText = cleanBody
      || (mediaType === 'sticker' ? '[Figurinha]' : mediaType === 'image' ? '[Imagem]' : mediaType === 'audio' ? '[Áudio]' : '[Mídia]');

    const member = this._findMemberForPhone(normalized);
    const resolvedName = member?.name || (contactName ? String(contactName).trim() : null);
    const unreadDelta = direction === 'in' ? 1 : 0;
    const pausedFlag = needsHuman ? 1 : 0;
    const humanFlag = needsHuman ? 1 : 0;
    const cleanSummary = handoffSummary ? String(handoffSummary).trim().slice(0, 240) : null;

    let msgId = null;
    try {
      this.store.run(
        `INSERT INTO whatsapp_chats (phone, contact_name, member_id, bot_paused, needs_human, handoff_summary, unread_count, last_message, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
         ON CONFLICT(phone) DO UPDATE SET
           contact_name = COALESCE(excluded.contact_name, whatsapp_chats.contact_name),
           member_id = COALESCE(excluded.member_id, whatsapp_chats.member_id),
           bot_paused = CASE WHEN excluded.bot_paused = 1 THEN 1 ELSE whatsapp_chats.bot_paused END,
           needs_human = CASE WHEN excluded.needs_human = 1 THEN 1 ELSE whatsapp_chats.needs_human END,
           handoff_summary = COALESCE(excluded.handoff_summary, whatsapp_chats.handoff_summary),
           unread_count = CASE WHEN ? > 0 THEN whatsapp_chats.unread_count + 1 ELSE 0 END,
           last_message = excluded.last_message,
           last_message_at = datetime('now', 'localtime')`,
        [normalized, resolvedName, member?.id || null, pausedFlag, humanFlag, cleanSummary, unreadDelta, previewText.slice(0, 240), unreadDelta],
      );
      const msgRes = this.store.run(
        `INSERT INTO whatsapp_chat_messages (phone, direction, sender_type, body, media_type, media_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [normalized, direction, senderType, cleanBody, mediaType || null, mediaUrl || null],
      );
      msgId = Number(msgRes.lastInsertRowid || 0) || null;
    } catch {
      return null;
    }
    return { id: msgId, phone: normalized };
  }

  saveAudioTranscription(chatMessageId, transcript) {
    const id = Number(chatMessageId);
    const clean = sanitizeReply(transcript);
    if (!Number.isInteger(id) || id <= 0 || !clean) return false;
    try {
      const row = this.store.get('SELECT id, phone, body FROM whatsapp_chat_messages WHERE id = ?', [id]);
      if (!row) return false;
      const formatted = `🎙️ "${clean}"`;
      this.store.run('UPDATE whatsapp_chat_messages SET body = ? WHERE id = ?', [formatted, id]);
      this.store.run(
        "UPDATE whatsapp_chats SET last_message = ? WHERE phone = ? AND (last_message = '[Áudio]' OR last_message = '' OR last_message IS NULL)",
        [formatted.slice(0, 240), row.phone],
      );
      return true;
    } catch {
      return false;
    }
  }

  listChats() {
    const items = this.store.all(
      `SELECT c.phone, c.contact_name, c.member_id, c.bot_paused, c.needs_human, c.handoff_summary, c.internal_note,
              COALESCE(c.opt_out, 0) AS opt_out, c.unread_count, c.last_message, c.last_message_at,
              m.name AS member_name, m.status AS member_status, m.valid_until AS member_valid_until
       FROM whatsapp_chats c
       LEFT JOIN members m ON m.id = c.member_id
       ORDER BY c.needs_human DESC, c.last_message_at DESC
       LIMIT 100`,
    );
    const needsHumanCount = items.filter((i) => Number(i.needs_human) === 1).length;
    const unreadTotal = items.reduce((acc, i) => acc + Number(i.unread_count || 0), 0);
    return { items, needsHumanCount, unreadTotal };
  }

  setInternalNote(phone, note = '') {
    const normalized = this._resolveChatPhone(phone) || normalizeBrPhone(phone) || String(phone || '').replace(/\D/g, '');
    if (!normalized) return null;
    const cleanNote = String(note || '').trim().slice(0, 500) || null;
    this.store.run(
      `INSERT INTO whatsapp_chats (phone, internal_note, last_message_at)
       VALUES (?, ?, datetime('now', 'localtime'))
       ON CONFLICT(phone) DO UPDATE SET internal_note = excluded.internal_note`,
      [normalized, cleanNote],
    );
    return { phone: normalized, internal_note: cleanNote };
  }

  getQuickReplies() {
    const defaults = [
      { label: 'Boas-vindas', text: 'Olá! Tudo bem? Como posso te ajudar hoje?' },
      { label: 'Link Matrícula', text: 'Para fazer sua matrícula online (escolher modalidade, turma, enviar foto do Face ID e pagar no Pix), acesse: https://sistema.academiaoxigenio.com/matricula.html' },
      { label: 'Pagamento MP', text: 'Para pagar sua mensalidade pelo WhatsApp, é só me enviar *quero pagar* que o sistema gera o Pix ou link de pagamento!' },
      { label: 'Encerrar', text: 'Já verifiquei por aqui! Se precisar de mais alguma coisa, é só chamar.' },
    ];
    try {
      const raw = String(this.store.getSettings?.().whatsapp_quick_replies || '').trim();
      if (!raw) return defaults;
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed) || !parsed.length) return defaults;
      const clean = parsed
        .map((item) => ({
          label: String(item?.label || '').trim().slice(0, 40),
          text: String(item?.text || '').trim().slice(0, 600),
        }))
        .filter((item) => item.label && item.text)
        .slice(0, 12);
      return clean.length ? clean : defaults;
    } catch {
      return defaults;
    }
  }

  saveQuickReplies(items = []) {
    const clean = (Array.isArray(items) ? items : [])
      .map((item) => ({
        label: String(item?.label || '').trim().slice(0, 40),
        text: String(item?.text || '').trim().slice(0, 600),
      }))
      .filter((item) => item.label && item.text)
      .slice(0, 12);
    this.store.updateSettings({ whatsapp_quick_replies: JSON.stringify(clean) });
    return this.getQuickReplies();
  }

  getChatMessages(phone, { markRead = true } = {}) {
    const normalized = normalizeBrPhone(phone) || String(phone || '').replace(/\D/g, '');
    if (!normalized) return { chat: null, messages: [] };
    const variants = brPhoneVariants(normalized);
    const phoneList = variants.length ? variants : [normalized];
    const placeholders = phoneList.map(() => '?').join(', ');
    if (markRead) {
      try {
        this.store.run(`UPDATE whatsapp_chats SET unread_count = 0 WHERE phone IN (${placeholders})`, phoneList);
      } catch {}
    }
    const chat = this.store.get(
      `SELECT c.*, m.name AS member_name, m.status AS member_status, m.valid_until AS member_valid_until
       FROM whatsapp_chats c
       LEFT JOIN members m ON m.id = c.member_id
       WHERE c.phone IN (${placeholders})
       ORDER BY CASE WHEN c.phone = ? THEN 0 ELSE 1 END, c.last_message_at DESC
       LIMIT 1`,
      [...phoneList, normalized],
    );
    const linkedMembers = this._findMembersForExactPhone(normalized);
    if (chat?.member_id && !linkedMembers.some((m) => Number(m.id) === Number(chat.member_id))) {
      const linkedById = this.store.get(
        `SELECT m.id, m.name, m.phone, m.status, m.valid_until, p.name AS plan_name
         FROM members m
         LEFT JOIN plans p ON p.id = m.plan_id
         WHERE m.id = ?`,
        [chat.member_id],
      );
      if (linkedById) linkedMembers.unshift(linkedById);
    }
    const messages = this.store.all(
      `SELECT id, phone, direction, sender_type, body, media_type, media_url, created_at
       FROM (
         SELECT id, phone, direction, sender_type, body, media_type, media_url, created_at
         FROM whatsapp_chat_messages
         WHERE phone IN (${placeholders})
         ORDER BY id DESC
         LIMIT 200
       )
       ORDER BY id ASC`,
      phoneList,
    );
    return { chat: chat || null, linkedMembers, messages };
  }

  setBotPaused(phone, paused) {
    if (paused) this.pauseContact(phone, this.humanPauseMs);
    else this.resumeContact(phone);
    return { phone: this._resolveChatPhone(phone) || normalizeBrPhone(phone) || phone, bot_paused: paused ? 1 : 0 };
  }

  setCampaignOptOut(phone, optOut) {
    const normalized = this._resolveChatPhone(phone) || normalizeBrPhone(phone) || String(phone || '').replace(/\D/g, '');
    if (!normalized) return null;
    const flag = optOut ? 1 : 0;
    const variants = brPhoneVariants(normalized);
    const phoneList = variants.length ? variants : [normalized];
    const placeholders = phoneList.map(() => '?').join(', ');
    this.store.run(
      `INSERT INTO whatsapp_chats (phone, opt_out, last_message_at)
       VALUES (?, ?, datetime('now', 'localtime'))
       ON CONFLICT(phone) DO UPDATE SET opt_out = excluded.opt_out`,
      [normalized, flag],
    );
    this.store.run(
      `UPDATE whatsapp_chats SET opt_out = ? WHERE phone IN (${placeholders})`,
      [flag, ...phoneList],
    );
    this.store.run(
      "UPDATE members SET whatsapp_opt_out = ?, updated_at = datetime('now', 'localtime') WHERE replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?",
      [flag, normalized.slice(-8)],
    );
    if (flag === 1) {
      this.store.run(
        `UPDATE whatsapp_logs SET status = 'skipped', error = 'Disparos automáticos pausados pela recepção'
         WHERE phone IN (${placeholders}) AND status = 'queued'`,
        phoneList,
      );
    }
    return { phone: normalized, opt_out: flag };
  }

  _getHistory(phone, nowMs = Date.now()) {
    const normalized = this._resolveChatPhone(phone);
    if (!normalized) return [];
    const entry = this._histories.get(normalized);
    if (entry) {
      if (nowMs - entry.updatedAt > this.historyTtlMs) {
        this._histories.delete(normalized);
      } else {
        return entry.turns;
      }
    }
    try {
      const limit = this.historyMaxTurns * 2;
      const variants = brPhoneVariants(normalized);
      const placeholders = variants.map(() => '?').join(', ');
      const rows = this.store.all(
        `SELECT direction, body FROM whatsapp_chat_messages
         WHERE phone IN (${placeholders}) AND COALESCE(TRIM(body), '') != ''
         ORDER BY id DESC LIMIT ?`,
        [...variants, limit],
      );
      if (rows.length > 0) {
        const turns = rows.reverse().map((r) => ({
          role: r.direction === 'in' ? 'user' : 'model',
          text: r.body,
        }));
        this._histories.set(normalized, { updatedAt: nowMs, turns });
        return turns;
      }
    } catch {
      // ignore if table not present
    }
    return [];
  }

  _appendHistory(phone, role, text, nowMs = Date.now()) {
    const normalized = this._resolveChatPhone(phone);
    if (!normalized || !text) return;
    const turns = [...this._getHistory(normalized, nowMs), { role, text }];
    const maxItems = this.historyMaxTurns * 2;
    const trimmed = turns.length > maxItems ? turns.slice(turns.length - maxItems) : turns;
    this._histories.set(normalized, { updatedAt: nowMs, turns: trimmed });
    if (this._histories.size > 1000) {
      this._histories.delete(this._histories.keys().next().value);
    }
  }

  loadBaseContext() {
    const settings = this.store.getSettings?.() || {};
    const customContext = String(settings.whatsapp_bot_context || '').trim();
    if (customContext) return customContext;

    try {
      const stat = fs.statSync(this.contextFilePath);
      if (this._cachedFileText !== null && stat.mtimeMs === this._cachedFileMtimeMs) {
        return this._cachedFileText;
      }
      const raw = fs.readFileSync(this.contextFilePath, 'utf8').trim();
      this._cachedFileText = raw;
      this._cachedFileMtimeMs = stat.mtimeMs;
      return raw;
    } catch {
      return 'Você é a assistente virtual da Academia Oxigênio. Seja objetiva, acolhedora e responda em Português do Brasil.';
    }
  }

  _buildMemberContext(phone, pushName) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return '';
    const members = this._findMembersForExactPhone(normalized);

    if (members.length > 0) {
      const todayIso = new Intl.DateTimeFormat('sv-SE', {
        timeZone: 'America/Sao_Paulo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
      const todayMs = Date.parse(`${todayIso}T00:00:00Z`);

      const lines = members.map((member) => {
        const firstName = String(member.name || '').trim().split(/\s+/)[0] || member.name;
        const info = [
          `Aluno: ${member.name} (chame de ${firstName})`,
          `situação: ${member.status || 'desconhecida'}`,
        ];
        if (member.plan_name) info.push(`plano: ${member.plan_name}`);
        if (member.valid_until) {
          const validMs = Date.parse(`${String(member.valid_until).slice(0, 10)}T00:00:00Z`);
          if (Number.isFinite(validMs) && Number.isFinite(todayMs)) {
            const diffDays = Math.round((validMs - todayMs) / 86400000);
            if (diffDays < 0) info.push(`validade: ${member.valid_until} (vencido há ${Math.abs(diffDays)} dia(s))`);
            else if (diffDays === 0) info.push(`validade: ${member.valid_until} (vence hoje)`);
            else info.push(`validade: ${member.valid_until} (vence em ${diffDays} dia(s))`);
          } else {
            info.push(`validade: ${member.valid_until}`);
          }
        }
        try {
          const openCharge = this.store.get(
            'SELECT due, amount FROM membership_charges WHERE member_id = ? AND payment_id IS NULL ORDER BY due ASC LIMIT 1',
            [member.id],
          );
          if (openCharge) {
            info.push(`cobrança em aberto: ${formatBrl(openCharge.amount)} (venc. ${openCharge.due})`);
          }
        } catch {}
        return `- ${info.join(' | ')}`;
      });
      return `# CONTEXTO DO ALUNO DESTE WHATSAPP\n${lines.join('\n')}`;
    }

    if (pushName && String(pushName).trim()) {
      return `# CONTEXTO DO CONTATO\nNome exibido no WhatsApp: ${String(pushName).trim()}.`;
    }
    return '';
  }

  _buildCatalogContext() {
    const sections = [];
    try {
      const plans = this.store.all(
        `SELECT name, duration_days, price_cents, allowed_start_time, allowed_end_time, weekly_limit
         FROM plans WHERE active = 1 ORDER BY price_cents ASC, name ASC`,
      );
      if (plans.length > 0) {
        const planLines = plans.map((p) => {
          const extras = [];
          if (p.duration_days) extras.push(`${p.duration_days} dias`);
          if (p.weekly_limit) extras.push(`${p.weekly_limit}x/semana`);
          if (p.allowed_start_time && p.allowed_end_time) extras.push(`${p.allowed_start_time}–${p.allowed_end_time}`);
          return `- ${p.name}: ${formatBrl(p.price_cents)}${extras.length ? ` (${extras.join(', ')})` : ''}`;
        });
        sections.push(`Planos ativos:\n${planLines.join('\n')}`);
      }
    } catch {}

    try {
      const classes = this.store.all(
        `SELECT c.name, c.schedule, c.capacity, m.name AS modality_name,
                COALESCE(c.allow_new_enrollments, 1) AS allow_new_enrollments,
                COALESCE(c.online_enrollment_mode, 'auto') AS online_enrollment_mode,
                (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
         FROM classes c
         LEFT JOIN modalities m ON m.id = c.modality_id
         WHERE c.active = 1 ORDER BY c.name ASC`,
      );
      if (classes.length > 0) {
        const classLines = classes.map((c) => {
          const mod = c.modality_name ? `${c.modality_name} — ` : '';
          const cap = Number(c.capacity || 0);
          const enrolled = Number(c.enrolled_count || 0);
          const spots = Math.max(0, cap - enrolled);
          const status = Number(c.allow_new_enrollments) === 0
            ? 'fechada para novas matrículas'
            : c.online_enrollment_mode === 'reception_only'
              ? 'vaga confirmada pela recepção'
              : spots === 0
                ? 'lotada'
                : `${spots} vaga(s) aberta(s) de ${cap}`;
          return `- ${mod}${c.name}: ${c.schedule} (${status})`;
        });
        sections.push(`Turmas e horários ativos:\n${classLines.join('\n')}`);
      }
    } catch {}

    try {
      const settings = this.store.getSettings?.() || {};
      const notices = resolveGymNotices(settings);
      if (notices.length > 0) {
        sections.push(`Avisos e horários especiais:\n${notices.map((n) => `- ${n}`).join('\n')}`);
      }
    } catch {}

    return sections.length > 0 ? `# DADOS ATUAIS DO SISTEMA (SEM DADOS PESSOAIS)\n${sections.join('\n\n')}` : '';
  }

  _buildSystemPrompt(phone, pushName) {
    const nowInfo = resolveBrazilNowInfo();
    const baseContext = this.loadBaseContext();
    const catalogContext = this._buildCatalogContext();
    const memberContext = this._buildMemberContext(phone, pushName);

    const parts = [
      `# RELÓGIO OFICIAL\nFuso horário oficial: ${nowInfo.timezone}\nData de hoje: ${nowInfo.dateBR}\nHora atual: ${nowInfo.timeBR}\nDia da semana oficial: ${nowInfo.weekday}.`,
      '# REGRA DE DATA\nQuando mencionar "hoje", use EXATAMENTE o dia da semana oficial acima. Nunca invente outro dia da semana.',
      '# REGRA ABSOLUTA DE PRIVACIDADE (LGPD)\n- NUNCA revele, confirme ou consulte dados pessoais, financeiros, de matrícula, telefone, CPF ou status de OUTRAS pessoas/alunos.\n- Use exclusivamente os dados do # CONTEXTO DO ALUNO DESTE WHATSAPP (se houver). Se alguém perguntar sobre terceiros, informe que por privacidade não é possível passar informações de outras pessoas pelo WhatsApp e encaminhe para atendimento humano se necessário.',
      '# REGRA DE TRANSFERÊNCIA POR CONTEXTO\n- Nunca peça transferência apenas porque não entendeu uma mensagem; nesse caso, faça uma pergunta curta para esclarecer.\n- Quando o usuário pedir uma informação factual da academia e a resposta confiável NÃO existir no contexto fornecido, responda EXATAMENTE ' + CONTEXT_MISSING_HANDOFF_MARKER + ' e nada mais.\n- Use o marcador somente para informação ausente, nunca para saudações ou conversa geral.',
      `# PLAYBOOKS\n${DEFAULT_PLAYBOOKS}`,
      baseContext,
      catalogContext,
      memberContext,
      'Se houver conflito entre histórico e base de conhecimento, priorize SEMPRE a base de conhecimento. Responda de forma curta, natural e acolhedora.',
    ];
    return parts.filter(Boolean).join('\n\n');
  }

  async _callGemini({ apiKey, model, contents }) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const response = await this.fetchFn(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents,
        generationConfig: { temperature: 0.4, maxOutputTokens: 2048 },
      }),
      signal: AbortSignal.timeout(25000),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error?.message || `Erro na API Gemini (${response.status})`);
    }
    const text = json?.candidates?.[0]?.content?.parts
      ?.filter((part) => !part?.thought)
      .map((part) => part?.text || '')
      .join('\n')
      .trim();
    if (!text) {
      throw new Error('Resposta vazia da API Gemini.');
    }
    return text;
  }

  async transcribeAudio({ base64Data, mimeType = 'audio/ogg', settings = this.store.getSettings?.() || {} }) {
    const rawKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    const apiKey = rawKey.replace(/^["']+|["']+$/g, '').trim();
    if (!apiKey || !base64Data) return null;
    const primaryModel = String(settings.gemini_transcribe_model || settings.gemini_model || 'gemini-2.5-flash').trim();
    const fallbackModel = String(settings.gemini_model || 'gemini-2.5-flash').trim();
    const models = primaryModel === fallbackModel ? [primaryModel] : [primaryModel, fallbackModel];
    for (const model of models) {
      try {
        const text = await this._callGemini({
          apiKey,
          model,
          contents: [
            {
              role: 'user',
              parts: [
                { text: 'Transcreva este áudio em português fielmente, retornando apenas o texto transcrito:' },
                { inlineData: { mimeType, data: base64Data } },
              ],
            },
          ],
        });
        const clean = sanitizeReply(text);
        if (clean) return clean;
      } catch {
        // tenta próximo modelo fallback
      }
    }
    return null;
  }

  async transcribeAndSaveAudioMessage({ chatMessageId, audioBuffer, audioMimeType = 'audio/ogg', settings = this.store.getSettings?.() || {} } = {}) {
    if (!chatMessageId || !audioBuffer?.length) return null;
    const transcript = await this.transcribeAudio({
      base64Data: Buffer.from(audioBuffer).toString('base64'),
      mimeType: audioMimeType || 'audio/ogg',
      settings,
    });
    if (transcript) {
      this.saveAudioTranscription(chatMessageId, transcript);
    }
    return transcript;
  }

  async handleIncomingMessage({ phone, text = '', audioBuffer = null, audioMimeType = '', pushName = '', chatMessageId = null } = {}) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return null;

    const settings = this.store.getSettings?.() || {};
    const rawKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    const apiKey = rawKey.replace(/^["']+|["']+$/g, '').trim();

    let userText = sanitizeReply(text);
    if (!userText && audioBuffer?.length && apiKey) {
      userText = await this.transcribeAudio({
        base64Data: Buffer.from(audioBuffer).toString('base64'),
        mimeType: audioMimeType || 'audio/ogg',
        settings,
      }) || '';
      if (userText && chatMessageId) {
        this.saveAudioTranscription(chatMessageId, userText);
      }
    }

    if (settings.whatsapp_bot_enabled !== '1') return null;
    if (!apiKey) return null;
    if (this.isPaused(normalized)) return null;
    if (!userText) return null;

    if (HUMAN_REQUEST_REGEX.test(userText)) {
      this.pauseContact(normalized, this.humanPauseMs);
      const reply = 'Claro! Vou encaminhar sua conversa para nossa equipe de atendimento humano. Assim que possível alguém já te responde por aqui.';
      const handoffSummary = `Solicitou atendente: "${userText.slice(0, 120)}"`;
      this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: reply, needsHuman: true, handoffSummary });
      return {
        reply,
        requiresHuman: true,
        reason: 'human_request',
      };
    }

    const salesResult = await this.onlineSalesBot.handleMessage({ phone: normalized, userText, settings });
    if (salesResult) {
      return salesResult;
    }

    const model = String(settings.gemini_model || 'gemini-3.8-flash').trim();
    const systemPrompt = this._buildSystemPrompt(normalized, pushName);
    const history = this._getHistory(normalized);
    const contents = [
      { role: 'user', parts: [{ text: systemPrompt }] },
      { role: 'model', parts: [{ text: 'Entendido. Seguirei fielmente o contexto e as regras da Academia Oxigênio.' }] },
      ...history.map((turn) => ({
        role: turn.role === 'model' ? 'model' : 'user',
        parts: [{ text: turn.text }],
      })),
      { role: 'user', parts: [{ text: userText }] },
    ];

    const rawReply = await this._callGemini({ apiKey, model, contents });
    if (rawReply.includes(CONTEXT_MISSING_HANDOFF_MARKER)) {
      this.pauseContact(normalized, this.humanPauseMs);
      const reply = 'Vou confirmar essa informação certinha com nossa equipe de atendimento humano e já te respondemos por aqui!';
      const handoffSummary = `Sem resposta no contexto: "${userText.slice(0, 120)}"`;
      this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: reply, needsHuman: true, handoffSummary });
      return {
        reply,
        requiresHuman: true,
        reason: 'context_missing',
      };
    }

    const cleanReply = sanitizeReply(rawReply.replaceAll(CONTEXT_MISSING_HANDOFF_MARKER, ''));
    if (!cleanReply) return null;

    if (LLM_HANDOFF_PROMISE_REGEX.test(cleanReply)) {
      this.pauseContact(normalized, this.humanPauseMs);
      const handoffSummary = `Encaminhado pela Hime: "${userText.slice(0, 120)}"`;
      this._appendHistory(normalized, 'user', userText);
      this._appendHistory(normalized, 'model', cleanReply);
      this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: cleanReply, needsHuman: true, handoffSummary });
      return {
        reply: cleanReply,
        requiresHuman: true,
        reason: 'llm_handoff_promise',
      };
    }

    this._appendHistory(normalized, 'user', userText);
    this._appendHistory(normalized, 'model', cleanReply);
    this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: cleanReply, needsHuman: false });

    return {
      reply: cleanReply,
      requiresHuman: false,
      reason: null,
    };
  }
}
