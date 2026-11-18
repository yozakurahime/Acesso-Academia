import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeBrPhone } from './whatsappService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CONTEXT_PATH = path.resolve(__dirname, '..', 'config', 'defaultBotContext.txt');

export const CONTEXT_MISSING_HANDOFF_MARKER = '[[HUMAN_HANDOFF_CONTEXT_MISSING]]';

const HUMAN_REQUEST_REGEX = /\b(atendente|humano|pessoa\s+real|falar\s+com\s+(?:algu[eé]m|atendente|recep[cç][aã]o|gerente|dono)|chamar\s+atendente|suporte\s+humano)\b/i;

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
    humanPauseMs = 4 * 60 * 60 * 1000,
    ownerTakeoverPauseMs = 30 * 60 * 1000,
    historyMaxTurns = 10,
    historyTtlMs = 6 * 60 * 60 * 1000,
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
        'UPDATE whatsapp_chats SET bot_paused = 0, needs_human = 0 WHERE phone = ?',
        [normalized],
      );
    } catch {}
  }

  markHumanTakeover(phone, nowMs = Date.now()) {
    this.pauseContact(phone, this.ownerTakeoverPauseMs, nowMs);
  }

  _findMemberForPhone(normalizedPhone) {
    if (!normalizedPhone) return null;
    try {
      return this.store.get(
        `SELECT id, name FROM members
         WHERE replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?
         ORDER BY id DESC LIMIT 1`,
        [normalizedPhone.slice(-8)],
      );
    } catch {
      return null;
    }
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

    try {
      this.store.run(
        `INSERT INTO whatsapp_chats (phone, contact_name, member_id, bot_paused, needs_human, unread_count, last_message, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
         ON CONFLICT(phone) DO UPDATE SET
           contact_name = COALESCE(excluded.contact_name, whatsapp_chats.contact_name),
           member_id = COALESCE(excluded.member_id, whatsapp_chats.member_id),
           bot_paused = CASE WHEN excluded.bot_paused = 1 THEN 1 ELSE whatsapp_chats.bot_paused END,
           needs_human = CASE WHEN excluded.needs_human = 1 THEN 1 ELSE whatsapp_chats.needs_human END,
           unread_count = CASE WHEN ? > 0 THEN whatsapp_chats.unread_count + 1 ELSE 0 END,
           last_message = excluded.last_message,
           last_message_at = datetime('now', 'localtime')`,
        [normalized, resolvedName, member?.id || null, pausedFlag, humanFlag, unreadDelta, previewText.slice(0, 240), unreadDelta],
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
      `SELECT c.phone, c.contact_name, c.member_id, c.bot_paused, c.needs_human,
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
    if (!entry) return [];
    if (nowMs - entry.updatedAt > this.historyTtlMs) {
      this._histories.delete(normalized);
      return [];
    }
    return entry.turns;
  }

  _appendHistory(phone, role, text, nowMs = Date.now()) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized || !text) return;
    const turns = [...this._getHistory(normalized, nowMs), { role, text }];
    const maxItems = this.historyMaxTurns * 2;
    const trimmed = turns.length > maxItems ? turns.slice(turns.length - maxItems) : turns;
    this._histories.set(normalized, { updatedAt: nowMs, turns: trimmed });
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
    const suffix = normalized.slice(-8);
    let member = null;
    try {
      member = this.store.get(
        `SELECT m.id, m.name, m.status, m.valid_until, p.name AS plan_name
         FROM members m
         LEFT JOIN plans p ON p.id = m.plan_id
         WHERE replace(replace(replace(replace(COALESCE(m.phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?
         ORDER BY m.id DESC
         LIMIT 1`,
        [suffix],
      );
    } catch {
      member = null;
    }

    if (member) {
      const firstName = String(member.name || '').trim().split(/\s+/)[0] || member.name;
      const parts = [
        `Aluno identificado no sistema: ${member.name} (chame de ${firstName}).`,
        `Situação do cadastro: ${member.status || 'desconhecida'}.`,
      ];
      if (member.plan_name) parts.push(`Plano: ${member.plan_name}.`);
      if (member.valid_until) parts.push(`Validade da matrícula: ${member.valid_until}.`);
      return `# CONTEXTO DO ALUNO\n${parts.join('\n')}`;
    }

    if (pushName && String(pushName).trim()) {
      return `# CONTEXTO DO CONTATO\nNome exibido no WhatsApp: ${String(pushName).trim()}.`;
    }
    return '';
  }

  _buildSystemPrompt(phone, pushName) {
    const nowInfo = resolveBrazilNowInfo();
    const baseContext = this.loadBaseContext();
    const memberContext = this._buildMemberContext(phone, pushName);

    const parts = [
      `# RELÓGIO OFICIAL\nFuso horário oficial: ${nowInfo.timezone}\nData de hoje: ${nowInfo.dateBR}\nHora atual: ${nowInfo.timeBR}\nDia da semana oficial: ${nowInfo.weekday}.`,
      '# REGRA DE DATA\nQuando mencionar "hoje", use EXATAMENTE o dia da semana oficial acima. Nunca invente outro dia da semana.',
      '# REGRA DE TRANSFERÊNCIA POR CONTEXTO\n- Nunca peça transferência apenas porque não entendeu uma mensagem; nesse caso, faça uma pergunta curta para esclarecer.\n- Quando o usuário pedir uma informação factual da academia e a resposta confiável NÃO existir no contexto fornecido, responda EXATAMENTE ' + CONTEXT_MISSING_HANDOFF_MARKER + ' e nada mais.\n- Use o marcador somente para informação ausente, nunca para saudações ou conversa geral.',
      `# PLAYBOOKS\n${DEFAULT_PLAYBOOKS}`,
      baseContext,
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
        generationConfig: { temperature: 0.4, maxOutputTokens: 600 },
      }),
      signal: AbortSignal.timeout(25000),
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error?.message || `Erro na API Gemini (${response.status})`);
    }
    const text = json?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || '')
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
      this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: reply, needsHuman: true });
      return {
        reply,
        requiresHuman: true,
        reason: 'human_request',
      };
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
      this.recordChatMessage({ phone: normalized, direction: 'out', senderType: 'bot', body: reply, needsHuman: true });
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
}
