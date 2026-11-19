import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBrPhone } from './whatsappService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTEXT_PATH = path.resolve(__dirname, '..', 'config', 'defaultBotContext.txt');

export const CONTEXT_MISSING_HANDOFF_MARKER = '[[HUMAN_HANDOFF_CONTEXT_MISSING]]';

const HUMAN_REQUEST_REGEX = /\b(atendente|humano|pessoa\s+real|falar\s+com\s+(?:algu[eé]m|atendente|recep[cç][aã]o|gerente|dono)|chamar\s+atendente|suporte\s+humano)\b/i;
const PAYMENT_INTENT_REGEX = /\b(pagar|pagamento|mensalidade|renovar|renova[cç][aã]o|pix|link\s+de\s+pagamento|quero\s+pagar)\b/i;
const PAYMENT_CANCEL_REGEX = /^(cancelar|sair|voltar|depois|n[aã]o\s+quero)$/i;
const PAYMENT_PIX_CHOICE_REGEX = /^(1|pix|qr|copia\s+e\s+cola)$/i;
const PAYMENT_LINK_CHOICE_REGEX = /^(2|link|cart[aã]o|cr[eé]dito|d[eé]bito)$/i;
const PAYMENT_CHECK_REGEX = /\b(j[aá]\s+paguei|paguei|verificar|confirmar\s+pagamento|conferir)\b/i;
const PAYMENT_DISCOUNT_REGEX = /\b(desconto|abatimento|pagar\s+menos|valor\s+menor|metade|parcelar\s+no\s+pix|fiado|combinado|promo[cç][aã]o)\b/i;

function formatBrl(cents) {
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

const DEFAULT_PLAYBOOKS = [
  'Mensalidade: Quando perguntarem valor da mensalidade ou preço de plano, responda com os valores que existirem no contexto. Se não houver valor no contexto, encaminhe para o atendimento humano.',
  'Modalidades: Quando perguntarem modalidades, responda com lista objetiva (nome, frequência, público e observações) priorizando clareza.',
  'Matrícula Online (Musculação): Para Musculação, oriente que o cliente pode fazer o cadastro, enviar a foto do Face ID e pagar via PIX diretamente pelo link https://sistema.academiaoxigenio.com/matricula.html (ou concluir com atendente humano).',
  'Regras de Vagas por Turma: Hidroginástica tem limite máximo de 15 alunos por horário; Natação Adulto tem limite máximo de 6 alunos por horário; Pilates das 18h está FECHADO para novas matrículas (somente alunos já matriculados continuam); Natação Infantil e Baby NÃO permitem matrícula ou confirmação automática de vaga online — sempre informe que a vaga precisa ser confirmada pela recepção/professor, colete idade da criança e horário de preferência, e encaminhe para atendimento humano.',
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
    humanPauseMs = 4 * 60 * 60 * 1000,
    ownerTakeoverPauseMs = 30 * 60 * 1000,
    historyMaxTurns = 10,
    historyTtlMs = 6 * 60 * 60 * 1000,
    paymentSessionTtlMs = 30 * 60 * 1000,
  } = {}) {
    this.store = store;
    this.contextFilePath = contextFilePath;
    this.fetchFn = fetchFn;
    this.gatewayService = gatewayService;
    this.humanPauseMs = humanPauseMs;
    this.ownerTakeoverPauseMs = ownerTakeoverPauseMs;
    this.historyMaxTurns = historyMaxTurns;
    this.historyTtlMs = historyTtlMs;
    this.paymentSessionTtlMs = paymentSessionTtlMs;
    this._pausedUntil = new Map();
    this._histories = new Map();
    this._paymentSessions = new Map();
    this._cachedFileText = null;
    this._cachedFileMtimeMs = 0;
  }

  setGatewayService(gatewayService) {
    this.gatewayService = gatewayService || null;
  }

  isPaused(phone, nowMs = Date.now()) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return false;
    try {
      const row = this.store.get('SELECT bot_paused FROM whatsapp_chats WHERE phone = ?', [normalized]);
      if (Number(row?.bot_paused) === 1) return true;
    } catch {
      // ignore if table not present
    }
    const until = this._pausedUntil.get(normalized);
    if (!until) return false;
    if (nowMs >= until) {
      this._pausedUntil.delete(normalized);
      return false;
    }
    return true;
  }

  pauseContact(phone, durationMs = this.humanPauseMs, nowMs = Date.now()) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return;
    this._pausedUntil.set(normalized, nowMs + Math.max(1000, Number(durationMs) || this.humanPauseMs));
    if (this._pausedUntil.size > 1000) {
      this._pausedUntil.delete(this._pausedUntil.keys().next().value);
    }
    try {
      this.store.run(
        `INSERT INTO whatsapp_chats (phone, bot_paused, last_message_at)
         VALUES (?, 1, datetime('now', 'localtime'))
         ON CONFLICT(phone) DO UPDATE SET bot_paused = 1`,
        [normalized],
      );
    } catch {}
  }

  resumeContact(phone) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return;
    this._pausedUntil.delete(normalized);
    try {
      this.store.run(
        'UPDATE whatsapp_chats SET bot_paused = 0, needs_human = 0, handoff_summary = NULL WHERE phone = ?',
        [normalized],
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
      return candidates.filter((m) => normalizeBrPhone(m.phone) === normalizedPhone);
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
    const normalized = normalizeBrPhone(phone);
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
      this.store.run(
        `INSERT INTO whatsapp_chat_messages (phone, direction, sender_type, body, media_type, media_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [normalized, direction, senderType, cleanBody, mediaType || null, mediaUrl || null],
      );
    } catch {
      return null;
    }
    return { phone: normalized };
  }

  listChats() {
    const items = this.store.all(
      `SELECT c.phone, c.contact_name, c.member_id, c.bot_paused, c.needs_human, c.handoff_summary,
              c.unread_count, c.last_message, c.last_message_at,
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

  getChatMessages(phone, { markRead = true } = {}) {
    const normalized = normalizeBrPhone(phone) || String(phone || '').replace(/\D/g, '');
    if (!normalized) return { chat: null, messages: [] };
    if (markRead) {
      try {
        this.store.run('UPDATE whatsapp_chats SET unread_count = 0 WHERE phone = ?', [normalized]);
      } catch {}
    }
    const chat = this.store.get(
      `SELECT c.*, m.name AS member_name, m.status AS member_status, m.valid_until AS member_valid_until
       FROM whatsapp_chats c
       LEFT JOIN members m ON m.id = c.member_id
       WHERE c.phone = ?`,
      [normalized],
    );
    const messages = this.store.all(
      `SELECT id, phone, direction, sender_type, body, media_type, media_url, created_at
       FROM whatsapp_chat_messages
       WHERE phone = ?
       ORDER BY id ASC
       LIMIT 200`,
      [normalized],
    );
    return { chat: chat || null, messages };
  }

  setBotPaused(phone, paused) {
    if (paused) this.pauseContact(phone, this.humanPauseMs);
    else this.resumeContact(phone);
    return { phone: normalizeBrPhone(phone) || phone, bot_paused: paused ? 1 : 0 };
  }

  _getHistory(phone, nowMs = Date.now()) {
    const normalized = normalizeBrPhone(phone);
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
      const rows = this.store.all(
        `SELECT direction, body FROM whatsapp_chat_messages
         WHERE phone = ? AND COALESCE(TRIM(body), '') != ''
         ORDER BY id DESC LIMIT ?`,
        [normalized, limit],
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
    const normalized = normalizeBrPhone(phone);
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
      const lines = members.map((member) => {
        const firstName = String(member.name || '').trim().split(/\s+/)[0] || member.name;
        const info = [
          `Aluno: ${member.name} (chame de ${firstName})`,
          `situação: ${member.status || 'desconhecida'}`,
        ];
        if (member.plan_name) info.push(`plano: ${member.plan_name}`);
        if (member.valid_until) info.push(`validade: ${member.valid_until}`);
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
        `SELECT c.name, c.schedule, c.capacity, m.name AS modality_name
         FROM classes c
         LEFT JOIN modalities m ON m.id = c.modality_id
         WHERE c.active = 1 ORDER BY c.name ASC`,
      );
      if (classes.length > 0) {
        const classLines = classes.map((c) => {
          const mod = c.modality_name ? `${c.modality_name} — ` : '';
          return `- ${mod}${c.name}: ${c.schedule} (capacidade ${c.capacity} alunos)`;
        });
        sections.push(`Turmas e horários ativos:\n${classLines.join('\n')}`);
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
    const model = String(settings.gemini_transcribe_model || 'gemini-3.5-transcribe').trim();
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
      return sanitizeReply(text);
    } catch {
      return null;
    }
  }

  async handleIncomingMessage({ phone, text = '', audioBuffer = null, audioMimeType = '', pushName = '' } = {}) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return null;

    const settings = this.store.getSettings?.() || {};
    if (settings.whatsapp_bot_enabled !== '1') return null;

    const rawKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    const apiKey = rawKey.replace(/^["']+|["']+$/g, '').trim();
    if (!apiKey) return null;

    if (this.isPaused(normalized)) return null;

    let userText = sanitizeReply(text);
    if (!userText && audioBuffer?.length) {
      userText = await this.transcribeAudio({
        base64Data: Buffer.from(audioBuffer).toString('base64'),
        mimeType: audioMimeType || 'audio/ogg',
        settings,
      }) || '';
    }
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

    const paymentResult = await this._handlePaymentFlow({ phone: normalized, userText, settings });
    if (paymentResult) {
      return paymentResult;
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

    this._appendHistory(normalized, 'user', userText);
    this._appendHistory(normalized, 'model', cleanReply);
    this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: cleanReply, needsHuman: false });

    return {
      reply: cleanReply,
      requiresHuman: false,
      reason: null,
    };
  }

  _getPaymentSession(phone, nowMs = Date.now()) {
    const entry = this._paymentSessions.get(phone);
    if (!entry) return null;
    if (nowMs - entry.updatedAt > this.paymentSessionTtlMs) {
      this._paymentSessions.delete(phone);
      return null;
    }
    return entry;
  }

  _setPaymentSession(phone, session, nowMs = Date.now()) {
    session.updatedAt = nowMs;
    this._paymentSessions.set(phone, session);
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
    // Exige nome completo exato (nunca busca parcial) para evitar enumeração de alunos por terceiros
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

  async _handlePaymentFlow({ phone, userText, settings }) {
    const existing = this._getPaymentSession(phone);
    const wantsPayment = PAYMENT_INTENT_REGEX.test(userText);
    if (!existing && !wantsPayment) return null;

    const mpConfigured = Boolean(this.gatewayService && String(settings.mp_access_token || '').trim());
    if (!mpConfigured) {
      if (!existing && wantsPayment) {
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

    if (existing && PAYMENT_CANCEL_REGEX.test(userText)) {
      this._paymentSessions.delete(phone);
      const reply = 'Certo, cancelei o fluxo de pagamento por aqui. Se precisar de outra ajuda, é só chamar!';
      this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
      return { reply, requiresHuman: false };
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
          this._paymentSessions.delete(phone);
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
        this._setPaymentSession(phone, existing);
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
      const session = this._setPaymentSession(phone, { items: ownItems, pendingChargeId: null });
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
      this._setPaymentSession(phone, existing);
    }
    const prefix = already
      ? `*${picked.member_name}* já está na lista deste pagamento:`
      : `Adicionei *${picked.member_name}* ao pagamento:`;
    const reply = this._buildPaymentMenuReply(existing.items, prefix);
    this.recordChatMessage({ phone, direction: 'out', senderType: 'bot', body: reply });
    return { reply, requiresHuman: false };
  }
}
