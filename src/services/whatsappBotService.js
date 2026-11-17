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
  'Matrícula: Quando pedirem matrícula, explique documentos, formas de pagamento, etapas e ofereça concluir com atendente humano.',
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
  }

  resumeContact(phone) {
    const normalized = normalizeBrPhone(phone);
    if (!normalized) return;
    this._pausedUntil.delete(normalized);
  }

  markHumanTakeover(phone, nowMs = Date.now()) {
    this.pauseContact(phone, this.ownerTakeoverPauseMs, nowMs);
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
    const apiKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
    if (!apiKey || !base64Data) return null;
    const model = String(settings.gemini_model || 'gemini-2.5-flash').trim();
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

    const apiKey = String(settings.gemini_api_key || process.env.GEMINI_API_KEY || '').trim();
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
      return {
        reply: 'Claro! Vou encaminhar sua conversa para nossa equipe de atendimento humano. Assim que possível alguém já te responde por aqui.',
        requiresHuman: true,
        reason: 'human_request',
      };
    }

    const model = String(settings.gemini_model || 'gemini-2.5-flash').trim();
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
      return {
        reply: 'Vou confirmar essa informação certinha com nossa equipe de atendimento humano e já te respondemos por aqui!',
        requiresHuman: true,
        reason: 'context_missing',
      };
    }

    const cleanReply = sanitizeReply(rawReply.replaceAll(CONTEXT_MISSING_HANDOFF_MARKER, ''));
    if (!cleanReply) return null;

    this._appendHistory(normalized, 'user', userText);
    this._appendHistory(normalized, 'model', cleanReply);

    return {
      reply: cleanReply,
      requiresHuman: false,
      reason: null,
    };
  }
}
