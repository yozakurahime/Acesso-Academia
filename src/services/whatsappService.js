import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestBaileysVersion,
  makeWASocket,
  useMultiFileAuthState,
} from '@whiskeysockets/baileys';

const GREETINGS = ['Olá', 'Oi', 'Tudo bem', 'Olá! Tudo bem'];
const AUTOMATED_CAMPAIGN_KINDS = [
  'due_reminder',
  'inactive',
  'birthday',
  'workout_review',
  'winback',
  'class_reminder',
];

function pickVariant(options) {
  return options[Math.floor(Math.random() * options.length)];
}

function resolveSpintax(text) {
  return String(text || '').replace(/\{([^{}|]+\|[^{}]+)\}/g, (_m, group) => {
    const parts = group.split('|');
    return pickVariant(parts);
  });
}

const SILENT_LOGGER = {
  level: 'silent',
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child() {
    return SILENT_LOGGER;
  },
};

export function normalizeBrPhone(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 || digits.length === 11) {
    digits = `55${digits}`;
  }
  if (!digits.startsWith('55') || digits.length < 12 || digits.length > 13) {
    return null;
  }
  return digits;
}

function formatMoneyBr(cents) {
  return ((Number(cents) || 0) / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

function formatDateBr(iso) {
  if (!iso) return '-';
  const match = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return String(iso);
  return `${match[3]}/${match[2]}/${match[1]}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function localTimeHHMM(now = new Date()) {
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function localDateIso(offsetDays = 0, now = new Date()) {
  const d = new Date(now.getTime());
  d.setDate(d.getDate() + offsetDays);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export class WhatsappService {
  constructor(store, { authDir, sleepFn = sleep, onReceiptMedia = null, onBotMessage = null } = {}) {
    this.store = store;
    this.authDir = authDir || null;
    this.sleep = sleepFn;
    this.onReceiptMedia = onReceiptMedia;
    this.onBotMessage = onBotMessage;
    this.sock = null;
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.connectedPhone = null;
    this.lastError = null;
    this.manualDisconnect = false;
    this.reconnectTimer = null;
    this.queueRunning = false;
    this._queueCancel = null;
    this._seenMediaIds = new Set();
    this._sentBotMessageIds = new Set();
  }

  setReceiptHandler(handler) {
    this.onReceiptMedia = handler;
  }

  setBotHandler(handler) {
    this.onBotMessage = handler;
  }

  hasSavedSession() {
    if (!this.authDir) return false;
    return fs.existsSync(path.join(this.authDir, 'creds.json'));
  }

  isWithinAllowedWindow(settings = this.store.getSettings(), now = new Date()) {
    const start = settings.whatsapp_window_start || '08:00';
    const end = settings.whatsapp_window_end || '20:00';
    const current = localTimeHHMM(now);
    return current >= start && current <= end;
  }

  countSentToday() {
    return (
      this.store.get(
        `SELECT COUNT(*) AS c FROM whatsapp_logs
         WHERE status = 'sent' AND date(sent_at) = date('now', 'localtime')`,
      )?.c ?? 0
    );
  }

  countQueued() {
    return this.store.get(`SELECT COUNT(*) AS c FROM whatsapp_logs WHERE status = 'queued'`)?.c ?? 0;
  }

  getStatus() {
    const settings = this.store.getSettings();
    return {
      status: this.status,
      phone: this.connectedPhone,
      qrDataUrl: this.qrDataUrl,
      queueLength: this.countQueued(),
      sentToday: this.countSentToday(),
      dailyLimit: Math.max(1, Number(settings.whatsapp_daily_limit || 40)),
      lastError: this.lastError,
      hasSavedSession: this.hasSavedSession(),
    };
  }

  listLogs(limit = 40) {
    return this.store.all(
      `SELECT wl.*, m.name AS member_name
       FROM whatsapp_logs wl
       LEFT JOIN members m ON m.id = wl.member_id
       ORDER BY wl.id DESC
       LIMIT ?`,
      [Number(limit)],
    );
  }

  renderTemplate(template, vars = {}) {
    const firstName = String(vars.name || '').trim().split(/\s+/)[0] || 'Aluno';
    const greeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
    const map = {
      '{saudacao}': greeting,
      '{nome}': String(vars.name || 'Aluno').trim(),
      '{primeiro_nome}': firstName,
      '{plano}': String(vars.planName || 'seu plano').trim(),
      '{valor}': vars.amountCents ? formatMoneyBr(vars.amountCents) : '',
      '{vencimento}': formatDateBr(vars.validUntil),
      '{academia}': String(vars.gymName || 'Academia').trim(),
      '{dias_sem_vir}': String(vars.daysInactive ?? ''),
    };
    let text = resolveSpintax(template || '');
    for (const [token, val] of Object.entries(map)) {
      text = text.replaceAll(token, val);
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  async connect() {
    if (!this.authDir) throw new Error('Diretório de sessão do WhatsApp não configurado.');
    if (this.status === 'connected' || this.status === 'connecting' || this.status === 'qr') {
      return this.getStatus();
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.manualDisconnect = false;
    this.lastError = null;
    this.status = 'connecting';
    await fs.promises.mkdir(this.authDir, { recursive: true });

    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch (err) {
      this.status = 'disconnected';
      this.lastError = `Falha ao obter versão do WhatsApp: ${err.message}`;
      this.scheduleReconnect();
      return this.getStatus();
    }
    if (this.manualDisconnect) {
      this.status = 'disconnected';
      return this.getStatus();
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Academia Oxigenio'),
      logger: SILENT_LOGGER,
      syncFullHistory: false,
      markOnlineOnConnect: false,
    });
    this.sock = sock;

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      const settings = this.store.getSettings();
      const allowReceipts = Boolean(this.onReceiptMedia) && settings.whatsapp_receipt_enabled === '1' && Boolean(settings.gemini_api_key);
      const allowBot = Boolean(this.onBotMessage) && settings.whatsapp_bot_enabled === '1' && Boolean(settings.gemini_api_key || process.env.GEMINI_API_KEY);
      for (const msg of messages || []) {
        try {
          const msgId = msg.key?.id;
          const jid = msg.key?.remoteJid || '';
          if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
          const senderPhone = jid.split('@')[0];

          if (msg.key?.fromMe) {
            if (msgId && this._sentBotMessageIds.has(msgId)) continue;
            if (allowBot && typeof this.onBotMessage?.markHumanTakeover === 'function') {
              this.onBotMessage.markHumanTakeover(senderPhone);
            }
            continue;
          }

          if (msgId) {
            if (this._seenMediaIds.has(msgId)) continue;
            this._seenMediaIds.add(msgId);
            if (this._seenMediaIds.size > 500) {
              this._seenMediaIds.delete(this._seenMediaIds.values().next().value);
            }
          }
          const content = msg.message?.ephemeralMessage?.message || msg.message?.viewOnceMessage?.message || msg.message;
          const incomingText = content?.conversation || content?.extendedTextMessage?.text || '';
          const handledOptCommand = incomingText ? this.handleIncomingText(senderPhone, incomingText) : false;

          if (!handledOptCommand && allowBot) {
            const audioMsg = content?.audioMessage;
            let audioBuffer = null;
            let audioMimeType = '';
            if (!incomingText && audioMsg && Number(audioMsg.fileLength || 0) <= 4 * 1024 * 1024) {
              audioBuffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: SILENT_LOGGER, reuploadRequest: sock.updateMediaMessage });
              audioMimeType = audioMsg.mimetype || 'audio/ogg';
            }
            if (incomingText || audioBuffer?.length) {
              const botResult = await this.onBotMessage.handleIncomingMessage({
                phone: senderPhone,
                text: incomingText,
                audioBuffer,
                audioMimeType,
                pushName: msg.pushName || '',
              });
              if (botResult?.reply) {
                const sent = await sock.sendMessage(jid, { text: botResult.reply });
                const sentId = sent?.key?.id;
                if (sentId) {
                  this._sentBotMessageIds.add(sentId);
                  if (this._sentBotMessageIds.size > 500) {
                    this._sentBotMessageIds.delete(this._sentBotMessageIds.values().next().value);
                  }
                }
              }
            }
          }

          if (!allowReceipts) continue;
          const imageMsg = content?.imageMessage;
          const docMsg = content?.documentMessage;
          const mimeType = imageMsg?.mimetype || docMsg?.mimetype || '';
          if (!mimeType.startsWith('image/') && mimeType !== 'application/pdf') continue;
          const declaredLen = Number(imageMsg?.fileLength || docMsg?.fileLength || 0);
          if (declaredLen > 8 * 1024 * 1024) continue;

          const buffer = await downloadMediaMessage(msg, 'buffer', {}, { logger: SILENT_LOGGER, reuploadRequest: sock.updateMediaMessage });
          if (!buffer?.length || buffer.length > 8 * 1024 * 1024) continue;
          await this.onReceiptMedia({
            base64Data: buffer.toString('base64'),
            mimeType,
            senderPhone,
            source: 'whatsapp',
          });
        } catch (err) {
          this.lastError = `Erro ao ler comprovante do WhatsApp: ${err.message}`;
        }
      }
    });
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          this.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
          this.status = 'qr';
        } catch (err) {
          this.lastError = err.message;
        }
      }

      if (connection === 'open') {
        this.status = 'connected';
        this.qrDataUrl = null;
        this.lastError = null;
        this.connectedPhone = String(sock.user?.id || '').split(':')[0] || null;
        this.processQueue().catch((err) => {
          this.lastError = err.message;
        });
      }

      if (connection === 'close') {
        this.qrDataUrl = null;
        this.connectedPhone = null;
        this.sock = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const loggedOut = code === DisconnectReason.loggedOut;
        if (loggedOut) {
          fs.promises.rm(this.authDir, { recursive: true, force: true }).catch(() => {});
          this.status = 'disconnected';
          this.lastError = 'Sessão encerrada no celular. Gere um novo QR Code.';
          return;
        }
        this.status = 'disconnected';
        if (!this.manualDisconnect) {
          this.lastError = lastDisconnect?.error?.message || 'Conexão encerrada. Reconectando...';
          this.scheduleReconnect(5000);
        }
      }
    });

    return this.getStatus();
  }

  scheduleReconnect(delayMs = 5000) {
    if (this.manualDisconnect || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch((err) => {
        this.lastError = err.message;
      });
    }, delayMs);
  }

  async disconnect({ clearSession = false } = {}) {
    this.manualDisconnect = true;
    if (this._queueCancel) {
      this._queueCancel();
      this._queueCancel = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.sock) {
      try {
        if (clearSession) await this.sock.logout();
        else this.sock.end(undefined);
      } catch {
        // ignore close errors
      }
      this.sock = null;
    }
    if (clearSession && this.authDir) {
      await fs.promises.rm(this.authDir, { recursive: true, force: true }).catch(() => {});
    }
    this.status = 'disconnected';
    this.qrDataUrl = null;
    this.connectedPhone = null;
    return this.getStatus();
  }

  handleIncomingText(senderPhone, text) {
    const normalized = normalizeBrPhone(senderPhone);
    if (!normalized) return false;
    const clean = String(text || '').trim().toLowerCase();
    if (/^(sair|parar|stop|cancelar|descadastrar|nao quero|não quero)\b/.test(clean)) {
      const localVariants = [normalized, normalized.slice(2)];
      for (const p of localVariants) {
        this.store.run(
          "UPDATE members SET whatsapp_opt_out = 1, updated_at = datetime('now', 'localtime') WHERE replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?",
          [p.slice(-9)],
        );
      }
      this.store.run(
        `UPDATE whatsapp_logs SET status = 'skipped', error = 'Opt-out solicitado pelo aluno'
         WHERE phone = ? AND status = 'queued'`,
        [normalized],
      );
      return true;
    }
    if (/^(voltar|ativar|receber)\b/.test(clean)) {
      this.store.run(
        "UPDATE members SET whatsapp_opt_out = 0, updated_at = datetime('now', 'localtime') WHERE replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ?",
        [normalized.slice(-9)],
      );
      return true;
    }
    return false;
  }

  enqueueMessage({ memberId = null, phone, kind, refKey = null, message }) {
    const normalizedPhone = normalizeBrPhone(phone);
    if (!normalizedPhone) return null;
    if (!message?.trim()) return null;

    if (AUTOMATED_CAMPAIGN_KINDS.includes(kind)) {
      const optedOut = memberId
        ? this.store.get('SELECT whatsapp_opt_out FROM members WHERE id = ?', [Number(memberId)])?.whatsapp_opt_out
        : null;
      if (Number(optedOut) === 1) return null;

      const phoneOptedOut = this.store.get(
        "SELECT id FROM members WHERE whatsapp_opt_out = 1 AND replace(replace(replace(replace(COALESCE(phone, ''), ' ', ''), '-', ''), '(', ''), ')', '') LIKE '%' || ? LIMIT 1",
        [normalizedPhone.slice(-9)],
      );
      if (phoneOptedOut) return null;
    }

    const knownBad = this.store.get(
      `SELECT id FROM whatsapp_logs
       WHERE phone = ? AND status = 'skipped' AND error = 'Número sem WhatsApp'
         AND created_at >= datetime('now', 'localtime', '-30 days')
       LIMIT 1`,
      [normalizedPhone],
    );
    if (knownBad) return null;

    if (refKey) {
      const exists = this.store.get(
        `SELECT id FROM whatsapp_logs
         WHERE member_id IS ? AND kind = ? AND ref_key = ? AND status IN ('queued', 'sent')`,
        [memberId, kind, refKey],
      );
      if (exists) return null;
    }

    const res = this.store.run(
      `INSERT INTO whatsapp_logs (member_id, phone, kind, ref_key, message, status)
       VALUES (?, ?, ?, ?, ?, 'queued')`,
      [memberId, normalizedPhone, kind, refKey, message.trim()],
    );
    return this.store.get('SELECT * FROM whatsapp_logs WHERE id = ?', [res.lastInsertRowid]);
  }

  async enqueuePaymentReceipt({ member, payment, plan }) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_payment !== '1') return null;
    if (!member?.phone) return null;

    const message = this.renderTemplate(
      settings.whatsapp_tpl_payment ||
        '{saudacao} {primeiro_nome}! Pagamento de {valor} ({plano}) confirmado na {academia}. Acesso liberado até {vencimento}.',
      {
        name: member.name,
        planName: plan?.name || 'Mensalidade',
        amountCents: payment?.amount_cents,
        validUntil: member.valid_until,
        gymName: settings.gym_name,
      },
    );

    const row = this.enqueueMessage({
      memberId: member.id,
      phone: member.phone,
      kind: 'payment',
      refKey: payment?.id ? `pay:${payment.id}` : null,
      message,
    });
    if (row && this.status === 'connected') {
      this.processQueue().catch(() => {});
    }
    return row;
  }

  async enqueueClassRemovalNotice({ member, removedClasses = [], graceDays = 5 }) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1') return null;
    if (!member?.phone || !removedClasses.length) return null;

    const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
    const classNames = removedClasses.map((c) => c.name).join(', ');
    const dueBr = formatDateBr(member.valid_until);
    const gymName = settings.gym_name || 'Academia Oxigênio';
    const message =
      `Olá ${firstName}! Aqui é da ${gymName}. ` +
      `Sua matrícula venceu em ${dueBr} e, após os ${graceDays} dias de tolerância sem renovação, ` +
      `sua vaga na turma (${classNames}) foi liberada para outros alunos. ` +
      `Assim que regularizar sua mensalidade na recepção ou pelo Portal do Aluno, poderemos verificar a disponibilidade de vaga novamente.`;

    const classKey = removedClasses.map((c) => c.id).sort((a, b) => a - b).join(',');
    const row = this.enqueueMessage({
      memberId: member.id,
      phone: member.phone,
      kind: 'class_removal',
      refKey: `class_removal:${member.valid_until || 'none'}:${classKey}`,
      message,
    });
    if (row && this.status === 'connected') {
      this.processQueue().catch(() => {});
    }
    return row;
  }

  async enqueueWelcomeMessage({ member, inviteCode = null }) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_welcome === '0') return null;
    if (!member?.phone) return null;

    const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
    const gymName = settings.gym_name || 'Academia Oxigênio';
    const portalUrl = process.env.STUDENT_PORTAL_URL || 'https://academiaoxigenio.com/aluno';
    const invitePart = inviteCode
      ? ` Seu código de convite para o primeiro acesso é: *${inviteCode}*.`
      : ' Use seu CPF/WhatsApp e o código de convite da recepção no primeiro acesso.';
    const message =
      `Olá ${firstName}! Seja muito bem-vindo(a) à *${gymName}*! 💪\n` +
      `Acesse seu Portal do Aluno (treinos, progresso, turmas e pagamentos) pelo celular em: ${portalUrl}.${invitePart}`;

    const row = this.enqueueMessage({
      memberId: member.id,
      phone: member.phone,
      kind: 'welcome',
      refKey: `welcome:${member.id}`,
      message,
    });
    if (row && this.status === 'connected') {
      this.processQueue().catch(() => {});
    }
    return row;
  }

  async enqueueWaitlistPromotion({ booking, member, classInfo }) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_waitlist === '0') return null;
    if (!member?.phone || !booking) return null;

    const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
    const gymName = settings.gym_name || 'Academia Oxigênio';
    const className = classInfo?.name || 'turma';
    const schedule = classInfo?.schedule ? ` (${classInfo.schedule})` : '';
    const dateBr = formatDateBr(booking.booking_date);
    const message =
      `Boa notícia, ${firstName}! Abriu uma vaga e sua reserva na *${className}*${schedule} para o dia ${dateBr} foi *confirmada* na ${gymName}. Te esperamos lá!`;

    const row = this.enqueueMessage({
      memberId: member.id,
      phone: member.phone,
      kind: 'waitlist_promoted',
      refKey: `waitlist:${booking.id}`,
      message,
    });
    if (row && this.status === 'connected') {
      this.processQueue().catch(() => {});
    }
    return row;
  }

  enqueueDueReminders(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_due !== '1') return 0;

    const daysBefore = Math.max(0, Math.min(7, Number(settings.whatsapp_due_days_before ?? 1)));
    const todayIso = localDateIso(0, now);
    const maxDueIso = localDateIso(daysBefore, now);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    if (remainingBudget === 0) return 0;

    const candidates = this.store.all(
      `SELECT m.id, m.name, m.phone, m.valid_until, p.name AS plan_name
       FROM members m
       LEFT JOIN plans p ON p.id = m.plan_id
       WHERE COALESCE(m.access_role, 'student') = 'student'
         AND m.status = 'active'
         AND m.phone IS NOT NULL AND trim(m.phone) <> ''
         AND m.valid_until BETWEEN ? AND ?
       ORDER BY m.valid_until ASC, m.id ASC`,
      [todayIso, maxDueIso],
    );

    let queued = 0;
    for (const member of candidates) {
      if (queued >= remainingBudget) break;
      const message = this.renderTemplate(
        settings.whatsapp_tpl_due ||
          '{saudacao} {primeiro_nome}! Seu plano {plano} na {academia} vence em {vencimento}.',
        {
          name: member.name,
          planName: member.plan_name || 'Plano',
          validUntil: member.valid_until,
          gymName: settings.gym_name,
        },
      );
      const inserted = this.enqueueMessage({
        memberId: member.id,
        phone: member.phone,
        kind: 'due_reminder',
        refKey: `due:${member.valid_until}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  enqueueInactiveCheckins(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_inactive !== '1') return 0;

    const inactiveDays = Math.max(3, Math.min(90, Number(settings.whatsapp_inactive_days ?? 10)));
    const todayIso = localDateIso(0, now);
    const cutoffIso = localDateIso(-inactiveDays, now);
    const cooldownIso = localDateIso(-14, now);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    if (remainingBudget === 0) return 0;

    const candidates = this.store.all(
      `SELECT m.id, m.name, m.phone,
              MAX(date(al.occurred_at)) AS last_visit
       FROM members m
       LEFT JOIN access_logs al ON al.member_id = m.id AND al.event_code = 7
       WHERE COALESCE(m.access_role, 'student') = 'student'
         AND m.status = 'active'
         AND (m.valid_until IS NULL OR m.valid_until >= ?)
         AND m.phone IS NOT NULL AND trim(m.phone) <> ''
         AND NOT EXISTS (
           SELECT 1 FROM whatsapp_logs wl
           WHERE wl.member_id = m.id
             AND wl.kind = 'inactive'
             AND wl.status IN ('queued', 'sent')
             AND date(wl.created_at) >= ?
         )
       GROUP BY m.id
       HAVING last_visit IS NOT NULL AND last_visit <= ?
       ORDER BY last_visit ASC, m.id ASC`,
      [todayIso, cooldownIso, cutoffIso],
    );

    let queued = 0;
    for (const member of candidates) {
      if (queued >= remainingBudget) break;
      const lastDate = new Date(`${member.last_visit}T00:00:00`);
      const daysAgo = Math.max(inactiveDays, Math.round((now.getTime() - lastDate.getTime()) / 86400000));
      const message = this.renderTemplate(
        settings.whatsapp_tpl_inactive ||
          '{saudacao} {primeiro_nome}! Sentimos sua falta na {academia} — já faz {dias_sem_vir} dias desde seu último treino.',
        {
          name: member.name,
          daysInactive: daysAgo,
          gymName: settings.gym_name,
        },
      );
      const inserted = this.enqueueMessage({
        memberId: member.id,
        phone: member.phone,
        kind: 'inactive',
        refKey: `inactive:${todayIso.slice(0, 7)}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  enqueueBirthdayMessages(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_birthday === '0') return 0;

    const todayIso = localDateIso(0, now);
    const mmdd = todayIso.slice(5, 10);
    const year = todayIso.slice(0, 4);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    if (remainingBudget === 0) return 0;

    const candidates = this.store.all(
      `SELECT id, name, phone, birth_date
       FROM members
       WHERE COALESCE(access_role, 'student') = 'student'
         AND COALESCE(is_visitor, 0) = 0
         AND status = 'active'
         AND phone IS NOT NULL AND trim(phone) <> ''
         AND birth_date IS NOT NULL AND substr(birth_date, 6, 5) = ?
       ORDER BY id ASC`,
      [mmdd],
    );

    let queued = 0;
    for (const member of candidates) {
      if (queued >= remainingBudget) break;
      const message = this.renderTemplate(
        settings.whatsapp_tpl_birthday ||
          'Parabéns, {primeiro_nome}! A {academia} deseja um feliz aniversário e muitos treinos incríveis neste novo ciclo!',
        {
          name: member.name,
          gymName: settings.gym_name,
        },
      );
      const inserted = this.enqueueMessage({
        memberId: member.id,
        phone: member.phone,
        kind: 'birthday',
        refKey: `birthday:${year}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  enqueueWorkoutReviewReminders(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_workout_review === '0') return 0;

    const cutoffIso = localDateIso(-45, now);
    const monthKey = localDateIso(0, now).slice(0, 7);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    if (remainingBudget === 0) return 0;

    const candidates = this.store.all(
      `SELECT m.id, m.name, m.phone,
              (SELECT MAX(substr(COALESCE(w.updated_at, w.created_at), 1, 10)) FROM workouts w WHERE w.member_id = m.id AND w.active = 1) AS last_workout,
              (SELECT MAX(substr(a.assessed_at, 1, 10)) FROM body_assessments a WHERE a.member_id = m.id) AS last_assessment
       FROM members m
       WHERE COALESCE(m.access_role, 'student') = 'student'
         AND COALESCE(m.is_visitor, 0) = 0
         AND m.status = 'active'
         AND m.phone IS NOT NULL AND trim(m.phone) <> ''
       ORDER BY m.id ASC`,
    );

    const gymName = settings.gym_name || 'Academia Oxigênio';
    let queued = 0;
    for (const member of candidates) {
      if (queued >= remainingBudget) break;
      const latest = [member.last_workout, member.last_assessment].filter(Boolean).sort().pop();
      if (!latest || latest > cutoffIso) continue;
      const recentSent = this.store.get(
        `SELECT id FROM whatsapp_logs
         WHERE member_id = ? AND kind = 'workout_review' AND substr(created_at, 1, 10) >= ?
         LIMIT 1`,
        [member.id, cutoffIso],
      );
      if (recentSent) continue;

      const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
      const greeting = pickVariant(GREETINGS);
      const message = pickVariant([
        `${greeting}, ${firstName}! Já faz mais de 45 dias desde sua última atualização de ficha/avaliação na ${gymName}. Que tal agendar uma revisão de treino com nossos professores?`,
        `${greeting} ${firstName}! Passando para lembrar que sua ficha/avaliação na ${gymName} já passou de 45 dias. Vamos atualizar seu treino para manter os resultados?`,
        `Oi ${firstName}! Tudo certo? Na ${gymName} recomendamos revisar sua ficha e avaliação física a cada 45 dias — fale com um professor quando vier treinar!`,
      ]);
      const inserted = this.enqueueMessage({
        memberId: member.id,
        phone: member.phone,
        kind: 'workout_review',
        refKey: `workout_review:${monthKey}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  enqueueWinBackMessages(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_winback === '0') return 0;

    const minIso = localDateIso(-90, now);
    const maxIso = localDateIso(-30, now);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    const winBackCap = Math.min(remainingBudget, 8);
    if (winBackCap === 0) return 0;

    const candidates = this.store.all(
      `SELECT id, name, phone, valid_until
       FROM members
       WHERE COALESCE(access_role, 'student') = 'student'
         AND COALESCE(is_visitor, 0) = 0
         AND COALESCE(whatsapp_opt_out, 0) = 0
         AND status <> 'active'
         AND phone IS NOT NULL AND trim(phone) <> ''
         AND valid_until IS NOT NULL
         AND valid_until BETWEEN ? AND ?
       ORDER BY valid_until DESC`,
      [minIso, maxIso],
    );

    const gymName = settings.gym_name || 'Academia Oxigênio';
    let queued = 0;
    for (const member of candidates) {
      if (queued >= winBackCap) break;
      const firstName = String(member.name || 'Aluno').trim().split(/\s+/)[0];
      const greeting = pickVariant(GREETINGS);
      const message = pickVariant([
        `${greeting}, ${firstName}! Sentimos sua falta aqui na ${gymName}! Estamos com condições especiais para você retomar seus treinos. Quer saber mais? (Se não quiser receber avisos, responda SAIR)`,
        `Oi ${firstName}, tudo bem? Faz um tempinho que você não treina na ${gymName}. Se quiser voltar à rotina com condições especiais, é só responder aqui! (Responda SAIR para não receber mais avisos)`,
        `${greeting} ${firstName}! A ${gymName} está de portas abertas caso queira retomar seus treinos este mês. Posso te passar os planos? (Caso prefira não receber, responda SAIR)`,
      ]);
      const inserted = this.enqueueMessage({
        memberId: member.id,
        phone: member.phone,
        kind: 'winback',
        refKey: `winback:${member.valid_until}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  enqueueClassReminders(now = new Date()) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1' || settings.whatsapp_notify_class_reminder === '0') return 0;

    const todayIso = localDateIso(0, now);
    const limit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
    const remainingBudget = Math.max(0, limit - this.countSentToday() - this.countQueued());
    if (remainingBudget === 0) return 0;

    const bookings = this.store.all(
      `SELECT cb.id, cb.member_id, cb.booking_date, c.name AS class_name, c.schedule,
              m.name AS member_name, m.phone AS member_phone
       FROM class_bookings cb
       JOIN classes c ON c.id = cb.class_id
       JOIN members m ON m.id = cb.member_id
       WHERE cb.booking_date = ?
         AND cb.status = 'confirmed'
         AND m.phone IS NOT NULL AND trim(m.phone) <> ''
       ORDER BY cb.id ASC`,
      [todayIso],
    );

    const gymName = settings.gym_name || 'Academia Oxigênio';
    let queued = 0;
    for (const b of bookings) {
      if (queued >= remainingBudget) break;
      const firstName = String(b.member_name || 'Aluno').trim().split(/\s+/)[0];
      const schedule = b.schedule ? ` (${b.schedule})` : '';
      const message = `Lembrete ${gymName}: ${firstName}, sua vaga na aula *${b.class_name}*${schedule} está confirmada para hoje (${formatDateBr(b.booking_date)}). Bom treino!`;
      const inserted = this.enqueueMessage({
        memberId: b.member_id,
        phone: b.member_phone,
        kind: 'class_reminder',
        refKey: `class_reminder:${b.id}`,
        message,
      });
      if (inserted) queued += 1;
    }
    return queued;
  }

  async runScheduledCampaigns({ ignoreWindow = false, now = new Date() } = {}) {
    const settings = this.store.getSettings();
    if (settings.whatsapp_enabled !== '1') {
      return {
        dueQueued: 0,
        inactiveQueued: 0,
        birthdayQueued: 0,
        workoutReviewQueued: 0,
        winBackQueued: 0,
        classReminderQueued: 0,
        skippedReason: 'disabled',
      };
    }
    if (!ignoreWindow && !this.isWithinAllowedWindow(settings, now)) {
      return {
        dueQueued: 0,
        inactiveQueued: 0,
        birthdayQueued: 0,
        workoutReviewQueued: 0,
        winBackQueued: 0,
        classReminderQueued: 0,
        skippedReason: 'outside_window',
      };
    }
    const dueQueued = this.enqueueDueReminders(now);
    const inactiveQueued = this.enqueueInactiveCheckins(now);
    const birthdayQueued = this.enqueueBirthdayMessages(now);
    const classReminderQueued = this.enqueueClassReminders(now);
    const workoutReviewQueued = this.enqueueWorkoutReviewReminders(now);
    const winBackQueued = this.enqueueWinBackMessages(now);
    const total = dueQueued + inactiveQueued + birthdayQueued + classReminderQueued + workoutReviewQueued + winBackQueued;
    if (total > 0 && this.status === 'connected') {
      this.processQueue().catch(() => {});
    }
    return {
      dueQueued,
      inactiveQueued,
      birthdayQueued,
      workoutReviewQueued,
      winBackQueued,
      classReminderQueued,
      skippedReason: null,
    };
  }

  async sendImmediate(phone, message, { kind = 'test', memberId = null } = {}) {
    if (this.status !== 'connected' || !this.sock) {
      throw new Error('WhatsApp não está conectado. Leia o QR Code em Configurações primeiro.');
    }
    const normalizedPhone = normalizeBrPhone(phone);
    if (!normalizedPhone) {
      throw new Error('Número de WhatsApp inválido. Use DDD + número (ex.: 11999998888).');
    }
    const [exists] = await this.sock.onWhatsApp(normalizedPhone);
    if (!exists?.exists) {
      throw new Error('Este número não possui WhatsApp ativo.');
    }
    const jid = exists.jid || `${normalizedPhone}@s.whatsapp.net`;
    await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
    await this.sleep(1500);
    await this.sock.sendMessage(jid, { text: String(message || '').trim() });
    await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});

    const res = this.store.run(
      `INSERT INTO whatsapp_logs (member_id, phone, kind, message, status, sent_at)
       VALUES (?, ?, ?, ?, 'sent', datetime('now', 'localtime'))`,
      [memberId, normalizedPhone, kind, String(message || '').trim()],
    );
    return this.store.get('SELECT * FROM whatsapp_logs WHERE id = ?', [res.lastInsertRowid]);
  }

  async processQueue() {
    if (this.queueRunning) return;
    if (this.status !== 'connected' || !this.sock) return;

    this.queueRunning = true;
    this.verifiedJids = this.verifiedJids || new Map();
    const sleepCancelable = (ms) => new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        this._queueCancel = null;
        resolve();
      };
      this._queueCancel = finish;
      this.sleep(ms).then(finish, finish);
    });
    const withTimeout = (promise, ms, label) => {
      let timer;
      return Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Timeout (${ms}ms) em ${label}`)), ms);
        }),
      ]).finally(() => clearTimeout(timer));
    };
    try {
      const automatedPlaceholders = AUTOMATED_CAMPAIGN_KINDS.map(() => '?').join(', ');
      let sentInBatch = 0;
      while (this.status === 'connected' && this.sock && !this.manualDisconnect) {
        const settings = this.store.getSettings();
        const dailyLimit = Math.max(1, Number(settings.whatsapp_daily_limit || 40));
        const allowAutomated = this.countSentToday() < dailyLimit && this.isWithinAllowedWindow(settings);
        const next = allowAutomated
          ? this.store.get(`SELECT * FROM whatsapp_logs WHERE status = 'queued' ORDER BY id ASC LIMIT 1`)
          : this.store.get(
              `SELECT * FROM whatsapp_logs WHERE status = 'queued' AND kind NOT IN (${automatedPlaceholders}) ORDER BY id ASC LIMIT 1`,
              AUTOMATED_CAMPAIGN_KINDS,
            );
        if (!next) break;

        try {
          let cached = this.verifiedJids.get(next.phone);
          if (!cached || Date.now() - cached.checkedAt > 86400000) {
            const [exists] = await withTimeout(this.sock.onWhatsApp(next.phone), 15000, 'onWhatsApp');
            cached = {
              exists: Boolean(exists?.exists),
              jid: exists?.jid || `${next.phone}@s.whatsapp.net`,
              checkedAt: Date.now(),
            };
            this.verifiedJids.set(next.phone, cached);
          }
          if (!cached.exists) {
            this.store.run(
              `UPDATE whatsapp_logs SET status = 'skipped', error = 'Número sem WhatsApp' WHERE id = ?`,
              [next.id],
            );
            continue;
          }
          const jid = cached.jid;
          await this.sock.sendPresenceUpdate('composing', jid).catch(() => {});
          await sleepCancelable(1400 + Math.floor(Math.random() * 1800));
          if (this.status !== 'connected' || !this.sock || this.manualDisconnect) break;
          await withTimeout(this.sock.sendMessage(jid, { text: next.message }), 15000, 'sendMessage');
          await this.sock.sendPresenceUpdate('paused', jid).catch(() => {});

          this.store.run(
            `UPDATE whatsapp_logs SET status = 'sent', sent_at = datetime('now', 'localtime') WHERE id = ?`,
            [next.id],
          );

          sentInBatch += 1;
          if (sentInBatch % 8 === 0) {
            const batchPauseMs = 180000 + Math.floor(Math.random() * 90000);
            await sleepCancelable(batchPauseMs);
          } else {
            const minDelayMs = Math.max(10, Number(settings.whatsapp_min_delay_sec || 15)) * 1000;
            const jitterMs = Math.floor(Math.random() * 12000);
            await sleepCancelable(minDelayMs + jitterMs);
          }
        } catch (err) {
          this.store.run(
            `UPDATE whatsapp_logs SET status = 'failed', error = ? WHERE id = ?`,
            [err.message, next.id],
          );
          await sleepCancelable(5000);
        }
      }
    } finally {
      this._queueCancel = null;
      this.queueRunning = false;
    }
  }
}
