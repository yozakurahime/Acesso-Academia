import { Router, raw } from 'express';
import path from 'node:path';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { StudentPortalService } from '../services/studentPortalService.js';
import { PartnerService } from '../services/partnerService.js';
import { completeFitnessWorkout, consecutiveDaysRanking, fitnessRanking, receptionFitnessSummary, saveFitnessPreferences, studentFitnessProgress, weeklyGoal } from '../services/fitnessProgress.js';
import { listExerciseCatalog, saveCatalogExercise } from '../services/exerciseCatalog.js';
import { MAX_EXERCISE_VIDEO } from '../services/exerciseVideos.js';
import { DeviceService } from '../services/deviceService.js';
import { FinanceService } from '../services/financeService.js';
import { BackupService } from '../services/backupService.js';
import { GoogleDriveBackupService } from '../services/googleDriveBackupService.js';
import { AuditService } from '../services/auditService.js';
import { EdgeCloudHub } from '../services/edgeSyncService.js';

const SECRET_SETTING_KEYS = [
  'controlid_password',
  'mp_access_token',
  'mp_point_access_token',
  'mp_webhook_secret',
  'mp_point_webhook_secret',
  'gemini_api_key',
  'wellhub_api_key',
  'wellhub_webhook_secret',
  'totalpass_api_token',
  'totalpass_webhook_secret',
  'controlid_callback_token',
  'backup_gdrive_client_secret',
  'backup_gdrive_refresh_token',
  'backup_gdrive_service_account_json',
];

const ALLOWED_SETTINGS_KEYS = new Set([
  'gym_name',
  'gym_phone',
  'controlid_ip',
  'controlid_port',
  'controlid_user',
  'controlid_password',
  'controlid_action_mode',
  'controlid_secbox_id',
  'controlid_group_id',
  'controlid_mock_mode',
  'controlid_callback_token',
  'toletus_ip',
  'toletus_port',
  'toletus_enabled',
  'tolerance_days',
  'whatsapp_enabled',
  'whatsapp_notify_payment',
  'whatsapp_notify_due',
  'whatsapp_due_days_before',
  'whatsapp_notify_inactive',
  'whatsapp_inactive_days',
  'whatsapp_notify_welcome',
  'whatsapp_notify_workout_review',
  'whatsapp_notify_winback',
  'whatsapp_notify_class_reminder',
  'whatsapp_notify_waitlist',
  'whatsapp_daily_limit',
  'whatsapp_min_delay_sec',
  'whatsapp_window_start',
  'whatsapp_window_end',
  'whatsapp_tpl_payment',
  'whatsapp_tpl_due',
  'whatsapp_tpl_inactive',
  'gemini_api_key',
  'gemini_model',
  'pix_recipient_name',
  'pix_recipient_key',
  'whatsapp_receipt_enabled',
  'whatsapp_receipt_auto_approve',
  'mp_access_token',
  'mp_point_access_token',
  'mp_webhook_secret',
  'mp_point_webhook_secret',
  'mp_point_terminal_id',
  'wellhub_enabled',
  'wellhub_require_checkin',
  'wellhub_api_key',
  'wellhub_gym_id',
  'wellhub_webhook_secret',
  'totalpass_enabled',
  'totalpass_require_checkin',
  'totalpass_api_token',
  'totalpass_gym_id',
  'totalpass_webhook_secret',
  'turnstile_release_seconds',
  'turnstile_direction',
  'turnstile_free_side',
  'antipassback_minutes',
  'max_capacity',
  'auto_collection_enabled',
  'backup_gdrive_enabled',
  'backup_gdrive_mode',
  'backup_gdrive_local_dir',
  'backup_gdrive_folder_id',
  'backup_gdrive_client_id',
  'backup_gdrive_client_secret',
  'backup_gdrive_refresh_token',
  'backup_gdrive_service_account_json',
]);

function maskSettings(settings) {
  const { auth_password_hash: _ph, auth_session_secret: _ss, ...safe } = settings;
  for (const key of SECRET_SETTING_KEYS) {
    safe[key] = settings[key] ? '******' : '';
  }
  if (process.env.MP_WEBHOOK_SECRET) safe.mp_webhook_secret = '******';
  if (process.env.MP_POINT_WEBHOOK_SECRET) safe.mp_point_webhook_secret = '******';
  if (process.env.MP_POINT_ACCESS_TOKEN) safe.mp_point_access_token = '******';
  if (process.env.MP_POINT_TERMINAL_ID) safe.mp_point_terminal_id = process.env.MP_POINT_TERMINAL_ID;
  return safe;
}

function validateDeviceHost(value, label) {
  const host = String(value || '').trim();
  if (!host || host.length > 255) {
    throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  }
  const lower = host.toLowerCase();
  if (
    lower === 'localhost' ||
    lower === '0.0.0.0' ||
    lower === '::' ||
    lower === '::1' ||
    lower.startsWith('127.') ||
    lower.startsWith('169.254.') ||
    lower.endsWith('.local')
  ) {
    throw Object.assign(new Error(`${label} não pode apontar para endereço local ou de metadados.`), { statusCode: 400 });
  }
  if (isIP(host) === 0 && !/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw Object.assign(new Error(`${label} inválido.`), { statusCode: 400 });
  }
}

function validatePort(value, label) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw Object.assign(new Error(`${label} deve ser uma porta válida (1-65535).`), { statusCode: 400 });
  }
}

function createRateLimiter({ max, windowMs, message, keyFn, decrementOnSuccess = false }) {
  const attempts = new Map();
  const MAX_ENTRIES = 5000;
  let lastCleanup = Date.now();
  const cleanupIntervalMs = Math.max(windowMs, 60_000);
  return (req, res, next) => {
    const key = keyFn(req);
    if (!key) return next();
    const now = Date.now();
    if (now - lastCleanup >= cleanupIntervalMs || attempts.size >= MAX_ENTRIES) {
      lastCleanup = now;
      for (const [k, entry] of attempts) {
        if (entry.until <= now) attempts.delete(k);
      }
      if (attempts.size >= MAX_ENTRIES) {
        const firstKey = attempts.keys().next().value;
        if (firstKey !== undefined) attempts.delete(firstKey);
      }
    }
    const existing = attempts.get(key);
    const attempt = existing && existing.until > now ? existing : { count: 0, until: now + windowMs };
    if (attempt.count >= max) {
      return res.status(429).json({ error: message });
    }
    attempt.count++;
    attempts.set(key, attempt);
    if (decrementOnSuccess) {
      res.once('finish', () => {
        if (res.statusCode < 400 && attempt.count > 0) attempt.count--;
      });
    }
    return next();
  };
}

function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isLocalDeviceRequest(req) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
    !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];
}

const handle = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch((err) => {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) {
      console.error('[API ERROR]', err);
    }
    res.status(status).json({
      error: status >= 500 ? 'Erro interno do servidor.' : (err.message || 'Erro interno'),
      ...(err.code === 'CASH_CLOSED' ? { code: err.code } : {}),
    });
  });
};

export function createApiRouter({ store, controlId, toletus, accessService, gymService, importService, whatsappService, whatsappBotService = null, receiptService, gatewayService, authService = null, studentPortalService = null, googleDriveBackupService = null, hotkeyToken, exerciseVideos, dataDir = null, edgeCloudHub = null, edgeSyncToken = process.env.EDGE_SYNC_TOKEN || '' }) {
  const router = Router();
  const portalService = studentPortalService || new StudentPortalService(store, gymService);
  const partnerService = new PartnerService(store);
  const deviceService = new DeviceService(store, controlId, toletus);
  const financeService = new FinanceService(store);
  const backupService = new BackupService(store, path.join(dataDir || './data', 'backups'));
  const gdriveBackup = googleDriveBackupService || new GoogleDriveBackupService(store);
  const auditService = new AuditService(store);
  const edgeHub = edgeCloudHub || new EdgeCloudHub(store);
  const requireAdmin = authService ? authService.requireRole('admin') : (_req, _res, next) => next();
  const requireReception = authService ? authService.requireRole('admin', 'reception') : (_req, _res, next) => next();
  const requireInstructor = authService ? authService.requireRole('admin', 'instructor') : (_req, _res, next) => next();
  const clientIpKey = (req) => {
    const remote = req.socket?.remoteAddress;
    if (remote && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote)) {
      const cfIp = req.headers?.['cf-connecting-ip'];
      if (cfIp) return String(cfIp).split(',')[0].trim();
      const xff = req.headers?.['x-forwarded-for'];
      if (xff) {
        const firstIp = String(xff).split(',')[0].trim();
        if (firstIp) return firstIp;
      }
    }
    return remote || req.ip || 'unknown';
  };
  const limitIpLogin = createRateLimiter({
    max: 10,
    windowMs: 10 * 60 * 1000,
    message: 'Muitas tentativas. Aguarde alguns minutos.',
    keyFn: clientIpKey,
    decrementOnSuccess: true,
  });
  const limitAccountLogin = createRateLimiter({
    max: 10,
    windowMs: 10 * 60 * 1000,
    message: 'Muitas tentativas para esta conta. Aguarde alguns minutos.',
    keyFn: (req) => {
      const id = String(req.body?.username || req.body?.identifier || '').trim().toLowerCase();
      return id ? `acct:${id}` : null;
    },
    decrementOnSuccess: true,
  });
  const limitLogin = [limitIpLogin, limitAccountLogin];
  const limitSetup = createRateLimiter({
    max: 10,
    windowMs: 10 * 60 * 1000,
    message: 'Muitas tentativas de configuração. Aguarde alguns minutos.',
    keyFn: (req) => req.socket?.remoteAddress || req.ip || 'unknown',
  });
  const limitWebhook = createRateLimiter({
    max: 120,
    windowMs: 60 * 1000,
    message: 'Limite de requisições de webhook excedido.',
    keyFn: clientIpKey,
  });
  const limitExpensive = createRateLimiter({
    max: 20,
    windowMs: 10 * 60 * 1000,
    message: 'Muitas solicitações em sequência. Aguarde alguns minutos.',
    keyFn: (req) => (req.studentMemberId ? `st:${req.studentMemberId}` : req.socket?.remoteAddress || req.ip || 'unknown'),
  });
  router.get('/public/plans', (_req, res) => {
    const plans = store.all(
      'SELECT id, name, duration_days, price_cents FROM plans WHERE active = 1 AND price_cents > 0 ORDER BY duration_days ASC, price_cents ASC, name ASC',
    );
    res.set('Cache-Control', 'no-cache').json({ plans });
  });

  router.get('/public/enrollment-options', (_req, res) => {
    const plans = store.all(
      'SELECT id, name, duration_days, price_cents FROM plans WHERE active = 1 AND price_cents > 0 ORDER BY duration_days ASC, price_cents ASC, name ASC',
    );
    const modalities = store.all('SELECT id, name, description FROM modalities WHERE active = 1 ORDER BY name ASC');
    const classes = store.all(
      `SELECT c.id, c.name, c.modality_id, mod.name AS modality_name, c.schedule, c.capacity,
              COALESCE(c.allow_new_enrollments, 1) AS allow_new_enrollments,
              COALESCE(c.online_enrollment_mode, 'auto') AS online_enrollment_mode,
              (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
       FROM classes c
       LEFT JOIN modalities mod ON mod.id = c.modality_id
       WHERE c.active = 1
       ORDER BY c.name ASC, c.schedule ASC`,
    ).map((c) => {
      const mode = c.online_enrollment_mode || 'auto';
      const allowNew = Number(c.allow_new_enrollments ?? 1) === 1;
      const spotsLeft = mode === 'reception_only' ? null : Math.max(0, Number(c.capacity || 0) - Number(c.enrolled_count || 0));
      return {
        id: c.id,
        name: c.name,
        modality_id: c.modality_id,
        modality_name: c.modality_name,
        schedule: c.schedule,
        capacity: c.capacity,
        allow_new_enrollments: allowNew ? 1 : 0,
        online_enrollment_mode: mode,
        spots_left: spotsLeft,
      };
    });
    res.set('Cache-Control', 'no-cache').json({ plans, modalities, classes });
  });

  router.post('/public/enroll', limitExpensive, handle(async (req, res) => {
    const body = req.body || {};
    const name = String(body.name || '').trim();
    const phone = String(body.phone || '').trim();
    const document = String(body.document || '').replace(/\D/g, '') || null;
    const birthDate = body.birth_date ? String(body.birth_date).trim() : null;
    const modalityId = body.modality_id ? Number(body.modality_id) : null;
    const classId = body.class_id ? Number(body.class_id) : null;
    const planId = body.plan_id ? Number(body.plan_id) : null;
    const photoBase64 = typeof body.photo_base64 === 'string' && body.photo_base64.trim() ? body.photo_base64.trim() : null;
    const childAge = body.child_age ? String(body.child_age).trim() : null;
    const preferredSchedule = body.preferred_schedule ? String(body.preferred_schedule).trim() : null;
    const notes = body.notes ? String(body.notes).trim() : null;

    if (!name || !phone) {
      return res.status(400).json({ error: 'Informe nome completo e WhatsApp.' });
    }

    const modality = modalityId ? store.get('SELECT * FROM modalities WHERE id = ? AND active = 1', [modalityId]) : null;
    const modalityName = String(body.modality_name || modality?.name || '').trim();
    const cls = classId
      ? store.get(
          `SELECT c.*, (SELECT COUNT(*) FROM class_enrollments ce WHERE ce.class_id = c.id) AS enrolled_count
           FROM classes c WHERE c.id = ? AND c.active = 1`,
          [classId],
        )
      : null;

    if (cls && Number(cls.allow_new_enrollments ?? 1) === 0) {
      return res.status(400).json({ error: 'Esta turma esta fechada para novas matriculas no momento.' });
    }

    const lowerMod = `${modalityName} ${cls?.name || ''}`.toLowerCase();
    const isKidsSwim = (lowerMod.includes('nata') || lowerMod.includes('baby'))
      && (lowerMod.includes('infantil') || lowerMod.includes('baby') || lowerMod.includes('crian'));
    const isReceptionOnly = isKidsSwim || cls?.online_enrollment_mode === 'reception_only';

    if (isReceptionOnly) {
      const ins = store.run(
        `INSERT INTO online_enrollment_requests
         (name, phone, document, birth_date, modality_id, modality_name, class_id, plan_id, child_age, preferred_schedule, notes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          name,
          phone,
          document,
          birthDate,
          modality?.id || null,
          modalityName || 'Natação Infantil / Baby',
          cls?.id || null,
          planId || null,
          childAge,
          preferredSchedule || cls?.schedule || null,
          notes,
          String(body.source || 'site'),
        ],
      );
      return res.status(201).json({
        mode: 'request',
        requestId: ins.lastInsertRowid,
        message: 'Solicitação recebida! As vagas de Natação Infantil e Baby são confirmadas diretamente pela recepção/professor via WhatsApp.',
      });
    }

    if (cls && Number(cls.enrolled_count || 0) >= Number(cls.capacity || 0)) {
      return res.status(400).json({ error: 'Esta turma atingiu o limite máximo de vagas.' });
    }

    if (!planId) {
      return res.status(400).json({ error: 'Selecione um plano para concluir a matricula.' });
    }
    const plan = store.get('SELECT * FROM plans WHERE id = ? AND active = 1', [planId]);
    if (!plan) {
      return res.status(400).json({ error: 'Plano selecionado nao encontrado.' });
    }

    if (document) {
      const existing = store.get("SELECT id, status FROM members WHERE REPLACE(REPLACE(COALESCE(document, ''), '.', ''), '-', '') = ?", [document]);
      if (existing) {
        return res.status(409).json({
          error: 'CPF ja cadastrado no sistema. Para renovar ou enviar foto, acesse o Portal do Aluno ou fale com a recepcao.',
        });
      }
    }

    const member = await accessService.createMember({
      name,
      phone,
      document,
      birth_date: birthDate,
      modality_id: modality?.id || cls?.modality_id || null,
      class_id: cls?.id || null,
      plan_id: plan.id,
      status: 'pending',
    });

    let faceSaved = false;
    let faceError = null;
    if (photoBase64) {
      try {
        await accessService.registerFace(member.id, photoBase64);
        faceSaved = true;
      } catch (err) {
        faceError = err.message;
      }
    }

    let pixCharge = null;
    let pixError = null;
    if (gatewayService && typeof gatewayService.createPixCharge === 'function') {
      try {
        pixCharge = await gatewayService.createPixCharge({ member_id: member.id, plan_id: plan.id });
      } catch (err) {
        pixError = err.message;
      }
    }

    res.status(201).json({
      mode: 'enrolled',
      member: { id: member.id, name: member.name, status: member.status },
      faceSaved,
      faceError,
      pixCharge,
      pixError,
      message: pixCharge
        ? 'Cadastro criado! Realize o pagamento via PIX abaixo para liberar a catraca.'
        : 'Cadastro criado! Procure a recepcao ou WhatsApp (62) 98102-0169 para concluir o pagamento.',
    });
  }));

  router.get('/public/pix/:id/status', handle(async (req, res) => {
    if (!gatewayService || typeof gatewayService.checkChargeStatus !== 'function') {
      return res.status(404).json({ error: 'Gateway PIX indisponivel.' });
    }
    const charge = await gatewayService.checkChargeStatus(Number(req.params.id));
    res.set('Cache-Control', 'no-store').json({
      id: charge.id,
      status: charge.status,
      paid_at: charge.paid_at || null,
    });
  }));

  router.get('/turnstile/display', (req, res) => {
    if (!isLocalDeviceRequest(req)) return res.sendStatus(403);
    const payload = req.query?.rich === '1' && typeof accessService.getTurnstileKioskDisplay === 'function'
      ? accessService.getTurnstileKioskDisplay()
      : accessService.getTurnstileDisplay();
    res.set('Cache-Control', 'no-store').json(payload);
  });
  router.get('/turnstile/ranking', handle(async (req, res) => {
    if (!isLocalDeviceRequest(req)) return res.sendStatus(403);
    const ranking = fitnessRanking(store, undefined, 3);
    if (req.query?.rich === '1') {
      const occ = typeof accessService?.getCurrentOccupancy === 'function' ? accessService.getCurrentOccupancy() : null;
      const summary = receptionFitnessSummary(store);
      const streakRanking = consecutiveDaysRanking(store, undefined, 5);
      return res.set('Cache-Control', 'no-store').json({
        ranking,
        streakRanking,
        occupancy: occ ? { count: occ.count, maxCapacity: occ.maxCapacity } : null,
        challenge: summary?.challenge || null,
        gymName: store.getSettings()?.gym_name || 'Academia Oxigênio',
      });
    }
    res.set('Cache-Control', 'no-store').json({ ranking });
  }));

  const requireEdgeToken = (req, res, next) => {
    const expected = String(edgeSyncToken || store.getSettings()?.edge_sync_token || '').trim();
    const authHeader = String(req.get('authorization') || '');
    const bearer = authHeader.toLowerCase().startsWith('bearer ') ? authHeader.slice(7).trim() : '';
    const provided = String(req.get('x-edge-token') || bearer || '').trim();
    if (!expected || !equalSecret(provided, expected)) {
      return res.status(401).json({ error: 'Token de sincronização edge inválido.' });
    }
    return next();
  };

  if (authService) {
    const requireAuth = authService.middleware();
    router.use((req, res, next) => {
      if (req.path.startsWith('/edge/') && req.path !== '/edge/status') return next();
      if (req.method === 'POST' && req.path === '/device/release' && isLocalDeviceRequest(req) &&
          equalSecret(req.get('x-oxigenio-hotkey'), hotkeyToken)) return next();
      requireAuth(req, res, next);
    });
  }

  router.get('/edge/status', requireAdmin, (_req, res) => {
    res.json(edgeHub.getStatus());
  });

  router.get('/edge/snapshot', requireEdgeToken, (_req, res) => {
    res.json(edgeHub.getSnapshot());
  });

  router.post('/edge/logs', requireEdgeToken, (req, res) => {
    res.json(edgeHub.ingestLogs(req.body?.logs || []));
  });

  router.post('/edge/controlid-users', requireEdgeToken, (req, res) => {
    res.json(edgeHub.ingestControlIdLinks(req.body?.links || []));
  });

  router.post('/edge/member-photos', requireEdgeToken, (req, res) => {
    res.json(edgeHub.ingestMemberPhotos(req.body?.photos || []));
  });

  router.post('/edge/commands/ack', requireEdgeToken, (req, res) => {
    res.json({ ok: edgeHub.ackCommand(req.body?.id) });
  });

  router.get('/edge/commands', requireEdgeToken, (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const unsubscribe = edgeHub.subscribeCommands((cmd) => {
      res.write(`event: command\ndata: ${JSON.stringify(cmd)}\n\n`);
    });

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);
    keepAlive.unref?.();

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  router.post('/turnstile/preview', handle(async (req, res) => {
    if (!isLocalDeviceRequest(req)) return res.sendStatus(403);
    accessService.previewTurnstileDisplay(req.body?.outcome);
    res.json({ ok: true });
  }));

  router.post('/turnstile/face-mirror', requireReception, (req, res) => {
    const state = accessService.setFaceMirror(req.body || {});
    res.json({ ok: true, active: Boolean(state?.active) });
  });

  router.get('/turnstile/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();
    res.write(': connected\n\n');

    const unsubscribe = typeof accessService.onTurnstileRelease === 'function'
      ? accessService.onTurnstileRelease((event) => {
          res.write(`event: release\ndata: ${JSON.stringify(event)}\n\n`);
        })
      : () => {};

    const keepAlive = setInterval(() => {
      res.write(': ping\n\n');
    }, 25000);
    keepAlive.unref?.();

    req.on('close', () => {
      clearInterval(keepAlive);
      unsubscribe();
    });
  });

  router.get('/auth/status', (req, res) => {
    if (!authService) {
      return res.json({ enabled: false, authenticated: true, username: 'admin', role: 'admin' });
    }
    const enabled = authService.isEnabled();
    const session = enabled ? authService.getSessionFromRequest(req) : null;
    const settings = store.getSettings();
    const authenticated = !enabled || Boolean(session);
    return res.json({
      enabled,
      authenticated,
      username: authenticated ? (session?.u || settings.auth_username || 'admin') : null,
      role: authenticated ? (session?.role || 'admin') : null,
      hasPassword: Boolean(settings.auth_password_hash),
    });
  });

  router.post('/auth/login', limitLogin, (req, res) => {
    if (!authService || !authService.isEnabled()) {
      return res.json({ ok: true, enabled: false });
    }
    const { username, password } = req.body || {};
    const user = authService.authenticateUser(username, password);
    if (!user) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }
    authService.setSessionCookie(req, res, user.username, user.role);
    return res.json({ ok: true, username: user.username, role: user.role });
  });

  router.post('/auth/logout', (req, res) => {
    if (authService) {
      const session = authService.getSessionFromRequest(req);
      if (session?.u) {
        authService.revokeUserTokens(session.u);
      }
      authService.clearSessionCookie(res);
    }
    return res.json({ ok: true });
  });

  router.post(
    '/auth/setup',
    requireAdmin,
    limitSetup,
    handle(async (req, res) => {
      if (!authService) throw new Error('Serviço de autenticação não inicializado.');
      const { enabled, username, password } = req.body || {};
      const result = authService.configure({ enabled: Boolean(enabled), username, password });
      if (result.enabled) {
        authService.setSessionCookie(req, res, result.username);
      } else {
        authService.clearSessionCookie(res);
      }
      auditService?.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'auth.setup',
        entity: 'auth',
        details: { enabled: Boolean(result.enabled), username: result.username || null },
      });
      res.json({ ok: true, ...result });
    }),
  );

  // ---- RBAC (Usuários), Auditoria & Backups ----
  router.get('/auth/users', requireAdmin, handle(async (_req, res) => {
    res.json(authService ? authService.listUsers() : []);
  }));

  router.post('/auth/users', requireAdmin, handle(async (req, res) => {
    if (!authService) throw new Error('Serviço de autenticação não inicializado.');
    const user = authService.createUser(req.body || {});
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'user.create',
      entity: 'app_user',
      entityId: user.id,
      details: { username: user.username, role: user.role },
    });
    res.status(201).json(user);
  }));

  router.put('/auth/users/:id', requireAdmin, handle(async (req, res) => {
    if (!authService) throw new Error('Serviço de autenticação não inicializado.');
    const user = authService.updateUser(req.params.id, req.body || {});
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'user.update',
      entity: 'app_user',
      entityId: user.id,
      details: { role: user.role, active: user.active },
    });
    res.json(user);
  }));

  router.delete('/auth/users/:id', requireAdmin, handle(async (req, res) => {
    if (!authService) throw new Error('Serviço de autenticação não inicializado.');
    const result = authService.deleteUser(req.params.id);
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'user.delete',
      entity: 'app_user',
      entityId: req.params.id,
    });
    res.json(result);
  }));

  router.get('/audit-logs', requireAdmin, handle(async (req, res) => {
    res.json(auditService.list({
      limit: req.query.limit || 100,
      entity: req.query.entity || null,
      actorUser: req.query.actor_user || null,
    }));
  }));

  router.post('/backups', requireAdmin, limitExpensive, handle(async (req, res) => {
    const backup = backupService.createBackup();
    let gdrive = null;
    try {
      gdrive = await gdriveBackup.syncBackup(backup);
    } catch (err) {
      gdrive = { ok: false, error: err.message };
    }
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'backup.create',
      entity: 'backup',
      entityId: backup.filename,
      details: { size: backup.size_bytes ?? backup.size, gdrive },
    });
    res.status(201).json({ ...backup, gdrive });
  }));

  router.post('/backups/gdrive/sync', requireAdmin, limitExpensive, handle(async (req, res) => {
    const backup = backupService.createBackup();
    const gdrive = await gdriveBackup.syncBackup(backup, { force: true });
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'backup.gdrive.sync',
      entity: 'backup',
      entityId: backup.filename,
      details: gdrive,
    });
    res.json({ ok: true, backup, gdrive });
  }));

  router.get('/backups/gdrive/auth-url', requireAdmin, handle(async (req, res) => {
    const redirectUri = `${req.protocol}://${req.get('host')}/api/backups/gdrive/callback`;
    const url = gdriveBackup.buildAuthUrl(redirectUri);
    res.json({ url, redirectUri });
  }));

  router.get('/backups/gdrive/callback', requireAdmin, handle(async (req, res) => {
    if (req.query?.error) {
      store.updateSettings({ backup_gdrive_last_error: String(req.query.error) });
      return res.redirect('/#settings');
    }
    const code = String(req.query?.code || '').trim();
    if (!code) return res.status(400).send('Código de autorização ausente.');
    const redirectUri = `${req.protocol}://${req.get('host')}/api/backups/gdrive/callback`;
    await gdriveBackup.exchangeAuthCode(code, redirectUri);
    res.redirect('/#settings');
  }));

  router.get('/backups', requireAdmin, handle(async (_req, res) => {
    res.json(backupService.listBackups());
  }));

  router.get('/backups/:filename', requireAdmin, handle(async (req, res) => {
    const filePath = backupService.getBackupPath(req.params.filename);
    res.download(filePath);
  }));

  router.get('/health', (_req, res) => {
    res.json({ ok: true, timestamp: new Date().toISOString() });
  });

  router.get(
    '/dashboard',
    handle(async (_req, res) => {
      res.json(accessService.getDashboardSummary());
    }),
  );

  router.get(
    '/reports/analytics',
    handle(async (req, res) => {
      res.json(accessService.getAnalyticsReport(req.query.month));
    }),
  );

  // Configuracoes e Catraca Control iD
  router.get('/settings', requireAdmin, (_req, res) => {
    res.json(maskSettings(store.getSettings()));
  });

  router.put(
    '/settings',
    requireAdmin,
    handle(async (req, res) => {
      const raw = req.body && typeof req.body === 'object' ? req.body : {};
      const payload = {};
      for (const key of Object.keys(raw)) {
        if (ALLOWED_SETTINGS_KEYS.has(key)) {
          payload[key] = raw[key];
        }
      }
      for (const key of SECRET_SETTING_KEYS) {
        if (payload[key] === '******') delete payload[key];
      }
      if (payload.controlid_password === '') {
        delete payload.controlid_password;
      }
      if (payload.controlid_ip !== undefined) validateDeviceHost(payload.controlid_ip, 'IP da Control iD');
      if (payload.toletus_ip !== undefined && String(payload.toletus_ip).trim() !== '') {
        validateDeviceHost(payload.toletus_ip, 'IP da Toletus');
      }
      if (payload.controlid_port !== undefined) validatePort(payload.controlid_port, 'Porta da Control iD');
      if (payload.toletus_port !== undefined && String(payload.toletus_port).trim() !== '') {
        validatePort(payload.toletus_port, 'Porta da Toletus');
      }
      const updated = store.updateSettings(payload);
      auditService?.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'settings.update',
        entity: 'settings',
        details: { keys: Object.keys(payload) },
      });
      res.json(maskSettings(updated));
    }),
  );

  router.post(
    '/device/test',
    handle(async (_req, res) => {
      const result = await controlId.testConnection();
      res.json(result);
    }),
  );

  router.post(
    '/device/test-toletus',
    handle(async (_req, res) => {
      const result = await toletus.testConnection();
      res.json(result);
    }),
  );

  router.post(
    '/device/release',
    requireReception,
    handle(async (req, res) => {
      const direction = req.body?.direction || null;
      const turnstileId = req.body?.turnstile_id ? Number(req.body.turnstile_id) : null;
      const isCloudRole = String(process.env.EDGE_ROLE || '').trim().toLowerCase() === 'cloud';
      const result = isCloudRole
        ? { queuedForEdge: true, command: edgeHub.enqueueCommand('release', { direction, turnstileId }) }
        : await accessService.releaseTurnstile(direction, 'LIBERADO', { turnstileId });
      auditService.log({
        actorUser: req.authUser || 'hotkey',
        actorRole: req.authRole || 'system',
        action: 'device.release',
        entity: 'turnstile',
        entityId: turnstileId,
        details: { direction },
      });
      res.json({ ok: true, result });
    }),
  );

  router.get('/occupancy', handle(async (_req, res) => {
    res.json(accessService.getCurrentOccupancy());
  }));

  router.post('/devices/readers/sync-all', requireAdmin, handle(async (_req, res) => {
    res.json(await accessService.syncAllReaders());
  }));

  // ---- Multiplas Catracas & Leitores Faciais ----
  router.get('/devices/turnstiles', (_req, res) => {
    res.json({ items: deviceService.listTurnstiles() });
  });

  router.post('/devices/turnstiles', requireAdmin, (req, res) => {
    const item = deviceService.createTurnstile(req.body || {});
    res.status(201).json({ item });
  });

  router.put('/devices/turnstiles/:id', requireAdmin, (req, res) => {
    const item = deviceService.updateTurnstile(req.params.id, req.body || {});
    res.json({ item });
  });

  router.delete('/devices/turnstiles/:id', requireAdmin, (req, res) => {
    const result = deviceService.deleteTurnstile(req.params.id);
    auditService?.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'device.turnstile.delete',
      entity: 'turnstile',
      entityId: req.params.id,
    });
    res.json(result);
  });

  router.post(
    '/devices/turnstiles/:id/test',
    handle(async (req, res) => {
      const result = await deviceService.testTurnstile(req.params.id);
      res.json(result);
    }),
  );

  router.post(
    '/devices/turnstiles/:id/apply',
    handle(async (req, res) => {
      const result = await deviceService.applyTurnstileConfig(req.params.id);
      res.json(result);
    }),
  );

  router.get('/devices/readers', (_req, res) => {
    res.json({ items: deviceService.listReaders() });
  });

  router.post('/devices/readers', requireAdmin, (req, res) => {
    const item = deviceService.createReader(req.body || {});
    res.status(201).json({ item });
  });

  router.put('/devices/readers/:id', requireAdmin, (req, res) => {
    const item = deviceService.updateReader(req.params.id, req.body || {});
    res.json({ item });
  });

  router.delete('/devices/readers/:id', requireAdmin, (req, res) => {
    const result = deviceService.deleteReader(req.params.id);
    auditService?.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'device.reader.delete',
      entity: 'reader',
      entityId: req.params.id,
    });
    res.json(result);
  });

  router.post(
    '/devices/readers/:id/test',
    handle(async (req, res) => {
      const result = await deviceService.testReader(req.params.id);
      res.json(result);
    }),
  );

  // Callback do Modo Online da Control iD quando reconhece uma face
  const handleControlIdIdentified = handle(async (req, res) => {
    const rawUserId = req.body?.user_id ?? req.query?.user_id;
    const userId = Number(rawUserId);
    const portalId = Number(req.body?.portal_id ?? req.query?.portal_id ?? 1);
    const readerIp = req.socket?.remoteAddress || req.ip || null;
    const readerId = req.query?.reader_id || req.body?.reader_id || null;
    const decision = await accessService.handleFaceIdentified(rawUserId, { readerIp, readerId });
    res.json({
      result: {
        event: decision.event ?? (decision.allowed ? 7 : 6),
        user_id: Number.isFinite(userId) ? userId : 0,
        user_name: decision.member?.name || '',
        user_image: false,
        portal_id: portalId,
        actions: [],
        message: decision.message,
      },
    });
  });

  router.post('/controlid/new_user_identified.fcgi', handleControlIdIdentified);
  router.post('/new_user_identified.fcgi', handleControlIdIdentified);
  router.post('/device_is_alive.fcgi', (_req, res) => res.json({ ok: true }));


  router.post(
    '/device/sync-logs',
    handle(async (_req, res) => {
      const result = await accessService.syncAccessLogs();
      res.json(result);
    }),
  );

  router.post(
    '/device/check-expired',
    handle(async (_req, res) => {
      const blocked = await accessService.checkExpiredMembers();
      res.json({ blockedCount: blocked.length, blocked });
    }),
  );

  // Planos
  router.get('/plans', (_req, res) => {
    res.json(accessService.listPlans());
  });

  router.post(
    '/plans',
    handle(async (req, res) => {
      const plan = accessService.createPlan(req.body);
      res.status(201).json(plan);
    }),
  );

  router.put(
    '/plans/:id',
    handle(async (req, res) => {
      const plan = accessService.updatePlan(req.params.id, req.body);
      res.json(plan);
    }),
  );

  router.delete(
    '/plans/:id',
    requireAdmin,
    handle(async (req, res) => {
      const result = accessService.deletePlan(req.params.id);
      res.json(result);
    }),
  );

  // Clientes / Membros
  router.get('/members', (req, res) => {
    const search = req.query.q || '';
    res.json(accessService.listMembers(search, { summary: req.query.view === 'summary' }));
  });
  router.get(
    '/members/check-name',
    handle(async (req, res) => res.json(gymService.checkMemberName(req.query.name || ''))),
  );
  router.get(
    '/members/check-cpf',
    handle(async (req, res) => res.json(gymService.checkMemberCpf(req.query.cpf || '', Number(req.query.excludeId) || 0))),
  );

  router.post(
    '/members',
    handle(async (req, res) => {
      const member = await accessService.createMember(req.body);
      if (whatsappService && (!member.access_role || member.access_role === 'student') && member.phone) {
        whatsappService.enqueueWelcomeMessage({ member }).catch(() => {});
      }
      res.status(201).json(member);
    }),
  );

  router.post(
    '/members/:id/face',
    handle(async (req, res) => {
      const member = await accessService.registerFace(req.params.id, req.body.imageBase64);
      res.json(member);
    }),
  );

  router.post(
    '/members/:id/cancel',
    handle(async (req, res) => {
      const result = await accessService.recordCancellation({
        member_id: req.params.id,
        reason: req.body?.reason,
        notes: req.body?.notes,
      });
      res.status(201).json(result);
    }),
  );

  router.get('/device/users/:id/identity', handle(async (req, res) => {
    res.json(await accessService.inspectDeviceLink(Number(req.params.id)));
  }));

  router.put('/members/:id/face-link', handle(async (req, res) => {
    res.json(await accessService.relinkDevice(req.params.id, req.body));
  }));

  router.get(
    '/members/:id/photo',
    handle(async (req, res) => {
      const buf = await accessService.getMemberPhoto(req.params.id);
      if (!buf) {
        return res.status(404).end();
      }
      res.type('image/jpeg').send(buf);
    }),
  );

  router.post(
    '/members/:id/status',
    handle(async (req, res) => {
      const result = await accessService.setMemberStatus(req.params.id, req.body.status);
      res.json(result);
    }),
  );

  router.post('/members/:id/freeze', requireReception, handle(async (req, res) => {
    const result = await accessService.freezeMember(req.params.id, req.body || {});
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'member.freeze',
      entity: 'member',
      entityId: req.params.id,
      details: req.body || {},
    });
    res.json(result);
  }));

  router.post('/members/:id/unfreeze', requireReception, handle(async (req, res) => {
    const result = await accessService.unfreezeMember(req.params.id);
    auditService.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'member.unfreeze',
      entity: 'member',
      entityId: req.params.id,
    });
    res.json(result);
  }));

  router.post('/members/:id/contract', handle(async (req, res) => {
    res.json(accessService.signMemberContract(req.params.id, req.body || {}));
  }));

  router.post('/visitors', requireReception, handle(async (req, res) => {
    res.status(201).json(await accessService.createVisitor(req.body || {}));
  }));

  router.post('/members/:id/convert-visitor', requireReception, handle(async (req, res) => {
    res.json(await accessService.convertVisitorToMember(req.params.id, req.body || {}));
  }));

  router.get('/members/:id/assessments', requireInstructor, handle(async (req, res) => {
    res.json(gymService.listAssessments(req.params.id));
  }));

  router.post('/members/:id/assessments', requireInstructor, handle(async (req, res) => {
    res.status(201).json(gymService.createAssessment(req.params.id, req.body || {}));
  }));

  router.delete('/assessments/:id', requireInstructor, handle(async (req, res) => {
    res.json(gymService.deleteAssessment(req.params.id));
  }));

  const notifyPromotedWaitlist = (promoted) => {
    if (!promoted || !whatsappService) return;
    const promotedMember = accessService.getMember(promoted.member_id);
    const classInfo = store.get('SELECT * FROM classes WHERE id = ?', [promoted.class_id]);
    whatsappService.enqueueWaitlistPromotion({ booking: promoted, member: promotedMember, classInfo }).catch(() => {});
  };

  router.get('/classes/:id/bookings', handle(async (req, res) => {
    res.json(gymService.listClassBookings(req.params.id, req.query.date));
  }));

  router.post('/classes/:id/bookings', requireReception, handle(async (req, res) => {
    const weeks = Number(req.body?.weeks || 1);
    if (weeks > 1) {
      return res.status(201).json(gymService.bookClassRecurring({
        classId: req.params.id,
        memberId: req.body?.member_id,
        startDate: req.body?.booking_date,
        weeks,
      }));
    }
    res.status(201).json(gymService.bookClass({
      classId: req.params.id,
      memberId: req.body?.member_id,
      bookingDate: req.body?.booking_date,
    }));
  }));

  router.post('/classes/:id/bookings/recurring', requireReception, handle(async (req, res) => {
    res.status(201).json(gymService.bookClassRecurring({
      classId: req.params.id,
      memberId: req.body?.member_id,
      startDate: req.body?.start_date || req.body?.booking_date,
      weeks: req.body?.weeks || 4,
    }));
  }));

  router.post('/bookings/:id/attendance', requireInstructor, handle(async (req, res) => {
    res.json(gymService.markBookingAttendance(req.params.id, req.body?.status));
  }));

  router.post('/bookings/:id/cancel', requireReception, handle(async (req, res) => {
    const out = gymService.cancelClassBooking(req.params.id, null);
    notifyPromotedWaitlist(out.promoted);
    res.json(out);
  }));

  // ---- Financeiro (Despesas, DRE, Comissões, Cobrança Automática) ----
  router.get('/finance/expenses', requireAdmin, handle(async (req, res) => {
    res.json(financeService.listExpenses({ status: req.query.status, month: req.query.month }));
  }));

  router.post('/finance/expenses', requireAdmin, handle(async (req, res) => {
    res.status(201).json(financeService.createExpense(req.body || {}));
  }));

  router.post('/finance/expenses/:id/pay', requireAdmin, handle(async (req, res) => {
    res.json(financeService.markExpensePaid(req.params.id, req.body?.payment_method || null));
  }));

  router.delete('/finance/expenses/:id', requireAdmin, handle(async (req, res) => {
    res.json(financeService.deleteExpense(req.params.id));
  }));

  router.get('/finance/dre', requireAdmin, handle(async (req, res) => {
    res.json(financeService.getDreSummary(req.query.month));
  }));

  router.get('/finance/commissions', requireAdmin, handle(async (req, res) => {
    res.json(financeService.listCommissions({ staffId: req.query.staff_id, status: req.query.status }));
  }));

  router.post('/finance/commissions', requireAdmin, handle(async (req, res) => {
    res.status(201).json(financeService.createCommission(req.body || {}));
  }));

  router.post('/finance/commissions/:id/pay', requireAdmin, handle(async (req, res) => {
    res.json(financeService.markCommissionPaid(req.params.id));
  }));

  router.post('/finance/auto-collection', requireAdmin, handle(async (_req, res) => {
    res.json(await financeService.runAutoCollection(whatsappService));
  }));

  // Pagamentos
  router.get('/payments', requireReception, (req, res) => {
    res.json(accessService.listPayments({ limit: req.query.limit || 100, q: req.query.q || '' }));
  });

  router.post('/members/:id/charges', requireReception, handle(async (req, res) => {
    res.status(201).json(accessService.createMembershipCharge(req.params.id, req.body));
  }));

  router.post(
    '/payments',
    requireReception,
    handle(async (req, res) => {
      const result = await accessService.recordPayment(req.body, { requireOpenCash: true });
      auditService.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'payment.create',
        entity: 'payment',
        entityId: result?.payment?.id ?? result?.id ?? null,
        details: { member_id: req.body?.member_id, amount_cents: result?.payment?.amount_cents ?? req.body?.amount_cents },
      });
      if (whatsappService) {
        whatsappService.enqueuePaymentReceipt(result).catch(() => {});
      }
      res.status(201).json(result);
    }),
  );

  router.get('/debts', requireReception, handle((req, res) => {
    const memberId = req.query.member_id ? Number(req.query.member_id) : null;
    const status = req.query.status || 'open';
    res.json(accessService.listMemberDebts(memberId, { status }));
  }));

  router.get('/members/:id/debts', requireReception, handle((req, res) => {
    res.json(accessService.listMemberDebts(req.params.id, { status: req.query.status || 'all' }));
  }));

  router.post(
    '/debts/:id/pay',
    requireReception,
    handle(async (req, res) => {
      const result = accessService.payMemberDebt(req.params.id, req.body, { requireOpenCash: true });
      auditService.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'debt.pay',
        entity: 'member_debt',
        entityId: Number(req.params.id),
        details: { member_id: result.debt?.member_id, payments: (result.payments || []).map((p) => p.amount_cents) },
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    '/debts/:id/cancel',
    requireReception,
    handle((req, res) => {
      const result = accessService.cancelMemberDebt(req.params.id, req.body);
      auditService.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'debt.cancel',
        entity: 'member_debt',
        entityId: Number(req.params.id),
        details: { member_id: result.debt?.member_id, reason: req.body?.reason || null },
      });
      res.json(result);
    }),
  );

  // Webhook para gateway de pagamento (Asaas, Mercado Pago, etc.)
  router.post(
    '/webhooks/payment',
    limitWebhook,
    handle(async (req, res) => {
      const secret = process.env.WEBHOOK_SECRET;
      if (!secret) return res.status(503).json({ error: 'Webhook de pagamento desativado.' });
      if (!equalSecret(req.get('x-webhook-secret'), secret)) {
        return res.status(401).json({ error: 'Assinatura de webhook invalida.' });
      }

      const { member_id, plan_id, amount_cents, external_id, status } = req.body;
      if (!['paid', 'confirmed', 'RECEIVED', 'CONFIRMED'].includes(status)) {
        return res.json({ ignored: true, status });
      }

      if (typeof external_id !== 'string' || !external_id.trim()) return res.status(400).json({ error: 'Informe o ID da transação.' });
      const result = await accessService.recordPayment({
        member_id,
        plan_id,
        amount_cents,
        method: 'gateway',
        external_id: external_id.trim(),
        notes: 'Confirmado via webhook de pagamento',
      }, { reconcileOpenCharge: true });
      res.json({ ok: true, result });
    }),
  );

  // Logs
  router.get('/logs', (_req, res) => {
    res.json(store.all('SELECT * FROM access_logs ORDER BY id DESC LIMIT 50'));
  });

  // Perfil do Aluno
  router.get(
    '/members/:id/profile',
    handle(async (req, res) => {
      res.json(gymService.getMemberProfile(req.params.id));
    }),
  );

  router.put(
    '/members/:id',
    handle(async (req, res) => {
      res.json(gymService.updateMember(req.params.id, req.body));
    }),
  );

  router.put('/members/:id/enrollment', handle(async (req, res) => {
    res.json(gymService.saveEnrollment(req.params.id, req.body));
  }));

  router.put('/members/:id/plan-enrollment', handle(async (req, res) => {
    res.json(await accessService.savePlanEnrollment(req.params.id, req.body));
  }));

  router.put('/members/:id/access-role', requireAdmin, handle(async (req, res) => {
    const result = await accessService.setAccessRole(req.params.id, req.body.access_role);
    auditService?.log({
      actorUser: req.authUser,
      actorRole: req.authRole,
      action: 'member.access_role.update',
      entity: 'member',
      entityId: req.params.id,
      details: { access_role: req.body?.access_role || null },
    });
    res.json(result);
  }));

  router.delete('/members/:id/enrollment/:modalityId', handle(async (req, res) => {
    res.json(gymService.removeEnrollment(req.params.id, req.params.modalityId));
  }));

  // Modalidades, Professores e Turmas
  router.get('/modalities', (_req, res) => res.json(gymService.listModalities()));
  router.post(
    '/modalities',
    handle(async (req, res) => res.status(201).json(gymService.createModality(req.body))),
  );
  router.put(
    '/modalities/:id',
    handle(async (req, res) => res.json(gymService.updateModality(req.params.id, req.body))),
  );
  router.delete(
    '/modalities/:id',
    requireAdmin,
    handle(async (req, res) => res.json(gymService.deleteModality(req.params.id))),
  );

  router.get('/instructors', (_req, res) => res.json(gymService.listInstructors()));
  router.post(
    '/instructors',
    handle(async (req, res) => res.status(201).json(gymService.createInstructor(req.body))),
  );

  router.get('/classes', (_req, res) => res.json(gymService.listClasses()));
  router.post(
    '/classes',
    handle(async (req, res) => res.status(201).json(gymService.createClass(req.body))),
  );
  router.put(
    '/classes/:id',
    handle(async (req, res) => res.json(gymService.updateClass(req.params.id, req.body))),
  );
  router.post(
    '/classes/:id/enroll',
    handle(async (req, res) => res.json(gymService.enrollMemberInClass(req.params.id, req.body.member_id))),
  );

  router.get('/online-enrollment-requests', requireReception, (_req, res) => {
    const rows = store.all('SELECT * FROM online_enrollment_requests ORDER BY id DESC LIMIT 100');
    res.json(rows);
  });
  router.post('/online-enrollment-requests/:id/status', requireReception, handle(async (req, res) => {
    const status = ['pending', 'approved', 'rejected'].includes(req.body?.status) ? req.body.status : 'approved';
    store.run('UPDATE online_enrollment_requests SET status = ? WHERE id = ?', [status, Number(req.params.id)]);
    res.json({ ok: true });
  }));

  // Atendentes (Equipe)
  router.get('/staff', (_req, res) => res.json(gymService.listStaff()));
  router.post(
    '/staff',
    handle(async (req, res) => res.status(201).json(gymService.createStaff(req.body))),
  );

  // Formas de Pagamento
  router.get('/payment-methods', (_req, res) => res.json(gymService.listPaymentMethods()));
  router.post(
    '/payment-methods',
    handle(async (req, res) => res.status(201).json(gymService.createPaymentMethod(req.body))),
  );
  router.patch(
    '/payment-methods/:id/toggle',
    handle(async (req, res) => res.json(gymService.togglePaymentMethod(req.params.id))),
  );

  // Produtos e Vendas (PDV)
  router.get('/products', (_req, res) => res.json(gymService.listProducts()));
  router.post(
    '/products',
    handle(async (req, res) => res.status(201).json(gymService.createProduct(req.body))),
  );
  router.get('/sales', requireReception, (_req, res) => res.json(gymService.listSales()));
  router.post(
    '/sales',
    requireReception,
    handle(async (req, res) => res.status(201).json(gymService.recordSale(req.body))),
  );

  // Caixa Completo
  router.get('/cash/current', requireReception, (_req, res) => res.json(gymService.getCurrentCashSession()));
  router.get('/cash/history', requireReception, (_req, res) => res.json(gymService.listCashHistory()));
  router.post(
    '/cash/open',
    requireReception,
    handle(async (req, res) => res.status(201).json(gymService.openCashSession(req.body))),
  );
  router.post(
    '/cash/movement',
    requireReception,
    handle(async (req, res) => res.status(201).json(gymService.addManualCashMovement(req.body))),
  );
  router.post(
    '/cash/close',
    requireReception,
    handle(async (req, res) => res.json(gymService.closeCashSession(req.body))),
  );

  // Importacao SCA e Control iD
  router.post(
    '/import/sca',
    requireAdmin,
    handle(async (req, res) => {
      const { htmlContent } = req.body || {};
      if (!htmlContent) {
        return res.status(400).json({ error: 'Arquivo HTML/XLS do SCA não enviado.' });
      }
      const preview = req.body.preview === true;
      const result = importService.importScaHtml(htmlContent, { preview });
      auditService?.log({
        actorUser: req.authUser,
        actorRole: req.authRole,
        action: 'import.sca',
        entity: 'import',
        details: { preview },
      });
      res.json(result);
    }),
  );

  router.post(
    '/import/controlid',
    requireAdmin,
    handle(async (_req, res) => {
      if (String(process.env.EDGE_ROLE || '').trim().toLowerCase() === 'cloud') {
        edgeHub.enqueueCommand('import_controlid', {});
        return res.json({
          queuedForEdge: true,
          linked: 0,
          imported: 0,
          conflicts: 0,
          message: 'Solicitação enviada para a catraca local puxar os IDs e cadastros faciais.',
        });
      }
      res.json(await importService.syncUsersFromControlId());
    }),
  );

  // WhatsApp (QR Code / Baileys com fila anti-ban)
  router.get('/whatsapp/status', (_req, res) => {
    if (!whatsappService) return res.status(503).json({ error: 'Serviço WhatsApp não inicializado.' });
    res.json(whatsappService.getStatus());
  });

  router.post(
    '/whatsapp/connect',
    handle(async (_req, res) => {
      if (!whatsappService) throw new Error('Serviço WhatsApp não inicializado.');
      res.json(await whatsappService.connect());
    }),
  );

  router.post(
    '/whatsapp/disconnect',
    requireAdmin,
    handle(async (req, res) => {
      if (!whatsappService) throw new Error('Serviço WhatsApp não inicializado.');
      res.json(await whatsappService.disconnect({ clearSession: Boolean(req.body?.clearSession) }));
    }),
  );

  router.post(
    '/whatsapp/test',
    handle(async (req, res) => {
      if (!whatsappService) throw new Error('Serviço WhatsApp não inicializado.');
      const { phone, message } = req.body || {};
      res.json(await whatsappService.sendImmediate(phone, message || 'Teste de conexão WhatsApp - Academia', { kind: 'test' }));
    }),
  );

  router.post(
    '/whatsapp/run-campaigns',
    requireAdmin,
    handle(async (req, res) => {
      if (!whatsappService) throw new Error('Serviço WhatsApp não inicializado.');
      res.json(await whatsappService.runScheduledCampaigns({ ignoreWindow: Boolean(req.body?.ignoreWindow) }));
    }),
  );

  router.get('/whatsapp/logs', (req, res) => {
    if (!whatsappService) return res.json([]);
    res.json(whatsappService.listLogs(req.query.limit || 40));
  });

  router.get('/whatsapp/chats', requireReception, (_req, res) => {
    if (!whatsappBotService) return res.json({ items: [], needsHumanCount: 0, unreadTotal: 0 });
    res.json(whatsappBotService.listChats());
  });

  router.get('/whatsapp/bot-context', requireAdmin, (_req, res) => {
    const s = store.getSettings();
    const context = whatsappBotService ? whatsappBotService.loadBaseContext() : (s.whatsapp_bot_context || '');
    res.json({
      context,
      isCustom: Boolean(String(s.whatsapp_bot_context || '').trim()),
      enabled: s.whatsapp_bot_enabled === '1',
    });
  });

  router.get('/whatsapp/chats/:phone/messages', requireReception, (req, res) => {
    if (!whatsappBotService) return res.json({ chat: null, messages: [] });
    res.json(whatsappBotService.getChatMessages(req.params.phone));
  });

  router.get('/whatsapp/media/:filename', requireReception, (req, res) => {
    const safeName = path.basename(String(req.params.filename || ''));
    if (!safeName || safeName !== req.params.filename) return res.sendStatus(400);
    const mediaPath = path.join(path.dirname(store.filePath || path.join(process.cwd(), 'data', 'acesso.sqlite')), 'chat_media', safeName);
    if (!fs.existsSync(mediaPath)) return res.sendStatus(404);
    res.sendFile(mediaPath);
  });

  router.post(
    '/whatsapp/chats/:phone/reply',
    requireReception,
    handle(async (req, res) => {
      if (!whatsappService) throw new Error('Serviço WhatsApp não inicializado.');
      const text = String(req.body?.text || '').trim();
      if (!text) return res.status(400).json({ error: 'Informe a mensagem.' });
      res.json(await whatsappService.sendChatMessage(req.params.phone, text));
    }),
  );

  router.post(
    '/whatsapp/chats/:phone/bot',
    requireReception,
    handle(async (req, res) => {
      if (!whatsappBotService) throw new Error('Bot WhatsApp não inicializado.');
      const paused = Boolean(req.body?.paused);
      res.json(whatsappBotService.setBotPaused(req.params.phone, paused));
    }),
  );

  // Comprovantes Pix / IA (Gemini)
  router.get('/receipts', requireReception, (req, res) => {
    if (!receiptService) return res.json([]);
    res.json(receiptService.listReceipts(req.query.limit || 30));
  });

  router.post(
    '/receipts/analyze',
    requireReception,
    limitExpensive,
    handle(async (req, res) => {
      if (!receiptService) throw new Error('Leitor de comprovantes não inicializado.');
      const { base64Data, mimeType, member_id } = req.body || {};
      res.status(201).json(
        await receiptService.processReceipt({
          base64Data,
          mimeType: mimeType || 'image/jpeg',
          source: 'upload',
          memberId: member_id || null,
        }),
      );
    }),
  );

  router.post(
    '/receipts/:id/approve',
    requireReception,
    handle(async (req, res) => {
      if (!receiptService) throw new Error('Leitor de comprovantes não inicializado.');
      res.json(await receiptService.approveReceipt(req.params.id, req.body || {}));
    }),
  );

  router.post(
    '/receipts/:id/reject',
    requireReception,
    handle(async (req, res) => {
      if (!receiptService) throw new Error('Leitor de comprovantes não inicializado.');
      res.json(receiptService.rejectReceipt(req.params.id, req.body?.reason));
    }),
  );

  // Gateways Online (Mercado Pago & Asaas)
  router.get('/gateways/charges', requireReception, (req, res) => {
    if (!gatewayService) return res.json([]);
    res.json(gatewayService.listCharges(req.query.limit || 20));
  });

  router.post(
    '/gateways/charges',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.status(201).json(await gatewayService.createPixCharge(req.body || {}));
    }),
  );

  router.post(
    '/gateways/charges/:id/check',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.checkChargeStatus(req.params.id));
    }),
  );
  router.post('/gateways/mp/whatsapp-checkout', requireReception, limitExpensive, handle(async (req, res) => {
    if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
    res.set('Cache-Control', 'no-store').status(201).json(await gatewayService.createWhatsAppCheckout(req.body?.member_id));
  }));

  // Assinaturas Recorrentes Mercado Pago
  router.get('/gateways/mp/subscriptions', requireReception, (req, res) => {
    if (!gatewayService) return res.json([]);
    res.json(gatewayService.listSubscriptions(req.query.limit || 50));
  });

  router.post(
    '/gateways/mp/subscriptions',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.status(201).json(await gatewayService.createMpSubscription(req.body || {}));
    }),
  );

  router.post(
    '/gateways/mp/subscriptions/:id/sync',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.syncMpSubscription(req.params.id));
    }),
  );

  router.delete(
    '/gateways/mp/subscriptions/:id',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.cancelMpSubscription(req.params.id));
    }),
  );

  // Mercado Pago Point Smart (Maquininha)
  router.get(
    '/gateways/mp/terminals',
    requireReception,
    handle(async (_req, res) => {
      if (!gatewayService) return res.json([]);
      res.json(await gatewayService.listPointTerminals());
    }),
  );

  router.post(
    '/gateways/mp/terminals/setup',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.setPointTerminalMode(req.body?.terminal_id, req.body?.operating_mode || 'PDV'));
    }),
  );

  router.get('/gateways/mp/point-orders', requireReception, (req, res) => {
    if (!gatewayService) return res.json([]);
    res.json(gatewayService.listPointOrders(req.query.limit || 20));
  });

  router.post(
    '/gateways/mp/point-orders',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.status(201).json(await gatewayService.createPointOrder(req.body || {}));
    }),
  );

  router.post(
    '/gateways/mp/point-orders/:id/check',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.checkPointOrder(req.params.id));
    }),
  );

  router.post(
    '/gateways/mp/point-orders/:id/cancel',
    requireReception,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      res.json(await gatewayService.cancelPointOrder(req.params.id));
    }),
  );

  router.post(
    '/webhooks/mercadopago',
    limitWebhook,
    handle(async (req, res) => {
      if (!gatewayService) return res.json({ ignored: true });
      const settings = store.getSettings();
      const secrets = [
        process.env.MP_WEBHOOK_SECRET || settings.mp_webhook_secret,
        process.env.MP_POINT_WEBHOOK_SECRET || settings.mp_point_webhook_secret,
      ].filter(Boolean);
      if (!secrets.length) return res.status(503).json({ error: 'Configure o segredo de webhook do Mercado Pago.' });
      const parts = new URLSearchParams((req.get('x-signature') || '').replaceAll(',', '&'));
      const timestamp = parts.get('ts')?.trim();
      const signature = parts.get('v1')?.trim();
      const requestId = req.get('x-request-id');
      const id = typeof req.query['data.id'] === 'string' ? req.query['data.id'] : '';
      const manifest = `id:${id.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
      if (!id || !requestId || !/^\d+$/.test(timestamp || '') ||
          !secrets.some((secret) => equalSecret(signature, createHmac('sha256', secret).update(manifest).digest('hex')))) {
        return res.status(401).json({ error: 'Assinatura de webhook inválida.' });
      }
      const tsNum = Number(timestamp);
      const tsSec = tsNum > 1e12 ? Math.floor(tsNum / 1000) : tsNum;
      const nowSec = Math.floor(Date.now() / 1000);
      if (!Number.isFinite(tsSec) || Math.abs(nowSec - tsSec) > 300) {
        return res.status(401).json({ error: 'Timestamp do webhook expirado.' });
      }
      res.json(await gatewayService.handleWebhook('mercadopago', { ...req.body, data: { ...req.body?.data, id } }, req.headers));
    }),
  );

  // Convênios (Wellhub / Gympass e TotalPass)
  router.get(
    '/partners/checkins',
    handle(async (req, res) => {
      res.json(
        partnerService.listCheckins({
          date: req.query.date || null,
          provider: req.query.provider || null,
          limit: req.query.limit || 50,
        }),
      );
    }),
  );

  router.post(
    '/partners/checkin',
    handle(async (req, res) => {
      const result = await partnerService.registerMemberCheckin({
        memberId: req.body?.member_id || null,
        provider: req.body?.provider || null,
        identifier: req.body?.identifier || null,
        source: 'manual',
      });
      res.status(201).json(result);
    }),
  );

  router.post(
    '/webhooks/wellhub',
    limitWebhook,
    handle(async (req, res) => {
      res.json(partnerService.handleWellhubWebhook(req.body || {}, req.headers || {}, req.rawBody ?? null));
    }),
  );

  router.post(
    '/webhooks/totalpass',
    limitWebhook,
    handle(async (req, res) => {
      res.json(await partnerService.handleTotalpassWebhook(req.body || {}, req.headers || {}, req.rawBody ?? null));
    }),
  );

  router.get('/exercise-catalog', handle(async (_req, res) => res.set('Cache-Control', 'no-store').json(listExerciseCatalog(store))));
  router.post('/exercise-catalog', requireAdmin, handle(async (req, res) => res.status(201).json(saveCatalogExercise(store, req.body))));
  router.put('/exercise-catalog/:key', requireAdmin, handle(async (req, res) => res.json(saveCatalogExercise(store, req.body, req.params.key))));
  if (exerciseVideos) {
    const readVideo = raw({ type: 'application/octet-stream', limit: MAX_EXERCISE_VIDEO, inflate: false });
    router.put('/exercise-catalog/:key/video', requireAdmin, (req, res, next) => readVideo(req, res, (err) => {
      if (err?.status === 413) return res.status(413).json({ error: 'O vídeo deve ter até 30 MB.' });
      if (err) return next(err);
      next();
    }), handle(async (req, res) => res.json(await exerciseVideos.save(req.params.key, req.body))));
    router.delete('/exercise-catalog/:key/video', requireAdmin, handle(async (req, res) => res.json(exerciseVideos.remove(req.params.key))));
    router.get('/exercise-catalog/:key/video', handle(async (req, res) => {
      const exercise = store.get('SELECT video_file FROM exercise_catalog WHERE key = ?', [req.params.key]);
      exerciseVideos.send(res, exercise?.video_file);
    }));
  }

  router.get('/workout-templates', requireInstructor, handle(async (_req, res) => res.json(gymService.listWorkoutTemplates())));
  router.post('/workout-templates', requireInstructor, handle(async (req, res) => res.status(201).json(gymService.saveWorkoutTemplate(req.body))));
  router.put('/workout-templates/:id', requireInstructor, handle(async (req, res) => res.json(gymService.saveWorkoutTemplate(req.body, req.params.id))));
  router.delete('/workout-templates/:id', requireInstructor, handle(async (req, res) => res.json(gymService.deleteWorkoutTemplate(req.params.id))));

  // --- Treinos dos Alunos (Admin / Professores) ---
  router.get(
    '/members/:id/workouts',
    requireInstructor,
    handle(async (req, res) => {
      res.json(gymService.listWorkoutsByMember(req.params.id));
    }),
  );

  router.post(
    '/members/:id/workouts',
    requireInstructor,
    handle(async (req, res) => {
      const workout = gymService.createWorkout({ ...req.body, member_id: req.params.id });
      res.status(201).json(workout);
    }),
  );

  router.put(
    '/workouts/:workoutId',
    requireInstructor,
    handle(async (req, res) => {
      res.json(gymService.updateWorkout(req.params.workoutId, req.body || {}));
    }),
  );

  router.delete(
    '/workouts/:workoutId',
    requireInstructor,
    handle(async (req, res) => {
      res.json(gymService.deleteWorkout(req.params.workoutId));
    }),
  );

  router.post(
    '/members/:id/portal-password',
    requireAdmin,
    handle(async (req, res) => {
      if (authService?.isEnabled() && !req.authUser) return res.status(403).json({ error: 'Entre como administrador para definir a senha do aluno.' });
      res.json(portalService.updatePortalPassword(req.params.id, { new_password: req.body?.password, force: true }));
    }),
  );

  // --- Crédito de Alunos ---
  router.get(
    '/members/:id/credit',
    handle(async (req, res) => {
      const member = accessService.getMember(req.params.id);
      if (!member) throw new Error('Aluno não encontrado.');
      res.json({
        credit_cents: Number(member.credit_cents || 0),
        logs: accessService.listMemberCreditLogs(req.params.id),
      });
    }),
  );

  router.post(
    '/members/:id/credit',
    handle(async (req, res) => {
      res.json(accessService.adjustMemberCredit(req.params.id, req.body || {}));
    }),
  );

  // --- Portal do Aluno (Sessão própria do aluno) ---
  router.post('/members/:id/portal-invite', handle(async (req, res) => {
    if (authService?.isEnabled() && !req.authUser) return res.status(403).json({ error: 'Entre como administrador para gerar convites.' });
    res.set('Cache-Control', 'no-store').json(portalService.issueInvite(req.params.id));
  }));
  const requireStudentAuth = authService
    ? authService.studentMiddleware()
    : (_req, res) => res.status(500).json({ error: 'AuthService não configurado.' });
  if (exerciseVideos) {
    router.get('/student/me/exercises/:id/video', requireStudentAuth, handle(async (req, res) => {
      const exercise = store.get(`SELECT c.video_file FROM workout_exercises e
        JOIN workouts w ON w.id = e.workout_id JOIN exercise_catalog c ON c.key = e.exercise_key
        WHERE e.id = ? AND w.member_id = ? AND w.active = 1`, [Number(req.params.id), req.studentMemberId]);
      exerciseVideos.send(res, exercise?.video_file);
    }));
  }

  router.get('/student/auth/status', (req, res) => {
    const session = authService?.getStudentSessionFromRequest(req);
    if (!session?.m) {
      return res.json({ authenticated: false, gymName: store.getSettings().gym_name || 'Academia Oxigênio' });
    }
    try {
      const profile = portalService.getStudentProfile(session.m);
      return res.json({ authenticated: true, ...profile });
    } catch {
      authService.clearStudentSessionCookie(res);
      return res.json({ authenticated: false, gymName: store.getSettings().gym_name || 'Academia Oxigênio' });
    }
  });

  router.post(
    '/student/auth/login',
    limitLogin,
    handle(async (req, res) => {
      if (!authService) throw new Error('Serviço de autenticação não inicializado.');
      const { identifier, secret } = req.body || {};
      const member = portalService.authenticateStudent(identifier, secret);
      authService.setStudentSessionCookie(req, res, member.id);
      res.json({ ok: true, member });
    }),
  );

  router.post('/student/auth/logout', (req, res) => {
    if (authService) {
      const session = authService.getStudentSessionFromRequest(req);
      if (session?.m) authService.revokeStudentTokens(session.m);
      authService.clearStudentSessionCookie(res);
    }
    res.json({ ok: true });
  });

  router.get(
    '/student/me',
    requireStudentAuth,
    handle(async (req, res) => {
      res.json(portalService.getStudentProfile(req.studentMemberId));
    }),
  );
  router.put('/members/:id/fitness-goal', handle(async (req, res) => {
    if (req.body?.goal === undefined) throw new Error('Informe a meta semanal.');
    const id = Number(req.params.id);
    saveFitnessPreferences(store, id, { goal: req.body.goal });
    res.json({ goal: weeklyGoal(store, id) });
  }));
  router.get('/student/me/fitness', requireStudentAuth, handle(async (req, res) => {
    res.set('Cache-Control', 'no-store').json(studentFitnessProgress(store, req.studentMemberId));
  }));
  router.put('/student/me/fitness/ranking', requireStudentAuth, handle(async (req, res) => {
    if (typeof req.body?.alias !== 'string') throw new Error('Informe um apelido ou deixe o campo vazio.');
    saveFitnessPreferences(store, req.studentMemberId, { alias: req.body.alias });
    res.json(studentFitnessProgress(store, req.studentMemberId));
  }));
  router.put('/student/me/fitness/goal', requireStudentAuth, handle(async (req, res) => {
    if (req.body?.goal === undefined) throw new Error('Informe a meta semanal.');
    saveFitnessPreferences(store, req.studentMemberId, { goal: req.body.goal });
    res.json(studentFitnessProgress(store, req.studentMemberId));
  }));
  router.put('/student/me/exercises/:id/load', requireStudentAuth, handle(async (req, res) => {
    res.json(portalService.updateExerciseLoad(req.studentMemberId, req.params.id, req.body?.load_kg));
  }));
  router.put('/student/me/contact', requireStudentAuth, handle(async (req, res) => {
    res.json({ member: portalService.updateContactInfo(req.studentMemberId, req.body || {}) });
  }));
  router.post('/student/me/workouts/:id/complete', requireStudentAuth, handle(async (req, res) => {
    const created = completeFitnessWorkout(store, req.studentMemberId, Number(req.params.id));
    res.json({ created, fitness: studentFitnessProgress(store, req.studentMemberId) });
  }));

  router.put(
    '/student/me/photo',
    requireStudentAuth,
    limitExpensive,
    handle(async (req, res) => {
      res.json(portalService.updateProfilePhoto(req.studentMemberId, req.body?.profile_photo ?? null));
    }),
  );

  router.put(
    '/student/me/password',
    requireStudentAuth,
    limitExpensive,
    handle(async (req, res) => {
      const { current_password, new_password } = req.body || {};
      res.json(portalService.updatePortalPassword(req.studentMemberId, { current_password, new_password }));
    }),
  );

  router.post(
    '/student/me/pix',
    requireStudentAuth,
    limitExpensive,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      const planId = req.body?.plan_id || null;
      const charge = await gatewayService.createPixCharge({ member_id: req.studentMemberId, plan_id: planId });
      res.status(201).json(charge);
    }),
  );

  router.post('/student/me/checkout', requireStudentAuth, limitExpensive, handle(async (req, res) => {
    if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
    const charge = await gatewayService.createCheckoutCharge({ member_id: req.studentMemberId, plan_id: req.body?.plan_id });
    res.set('Cache-Control', 'no-store').status(201).json({ id: charge.id, amount_cents: charge.amount_cents, payment_url: charge.payment_url });
  }));

  router.post(
    '/student/me/pix/:chargeId/check',
    requireStudentAuth,
    limitExpensive,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      const charge = store.get('SELECT id, member_id FROM gateway_charges WHERE id = ?', [Number(req.params.chargeId)]);
      if (!charge || Number(charge.member_id) !== Number(req.studentMemberId)) {
        return res.status(404).json({ error: 'Cobrança Pix não encontrada.' });
      }
      const result = await gatewayService.checkChargeStatus(req.params.chargeId);
      res.json({ paid: result.paid, status: result.charge.status });
    }),
  );

  router.post(
    '/student/me/subscription',
    requireStudentAuth,
    limitExpensive,
    handle(async (req, res) => {
      if (!gatewayService) throw new Error('Gateway de pagamento não inicializado.');
      const { plan_id = null, payer_email = null } = req.body || {};
      const sub = await gatewayService.createMpSubscription({
        member_id: req.studentMemberId,
        plan_id,
        payer_email,
      });
      res.status(201).json(sub);
    }),
  );

  router.get('/student/assessments', requireStudentAuth, handle(async (req, res) => {
    res.json(gymService.listAssessments(req.studentMemberId));
  }));

  router.get('/student/gamification', requireStudentAuth, handle(async (req, res) => {
    res.json(gymService.getMemberGamification(req.studentMemberId));
  }));

  router.get('/student/bookings', requireStudentAuth, handle(async (req, res) => {
    res.json(gymService.listMemberBookings(req.studentMemberId));
  }));

  router.get('/student/classes', requireStudentAuth, handle(async (_req, res) => {
    res.json(gymService.listClasses());
  }));

  router.post('/student/bookings', requireStudentAuth, handle(async (req, res) => {
    res.status(201).json(gymService.bookClass({
      classId: req.body?.class_id ?? req.body?.classId,
      memberId: req.studentMemberId,
      bookingDate: req.body?.booking_date ?? req.body?.bookingDate,
    }));
  }));

  router.post('/student/bookings/recurring', requireStudentAuth, handle(async (req, res) => {
    res.status(201).json(gymService.bookClassRecurring({
      classId: req.body?.class_id ?? req.body?.classId,
      memberId: req.studentMemberId,
      startDate: req.body?.start_date || req.body?.booking_date || req.body?.startDate || req.body?.bookingDate,
      weeks: req.body?.weeks || 4,
    }));
  }));

  router.delete('/student/bookings/:id', requireStudentAuth, handle(async (req, res) => {
    const out = gymService.cancelClassBooking(req.params.id, req.studentMemberId);
    notifyPromotedWaitlist(out.promoted);
    res.json(out);
  }));

  router.post('/student/contract', requireStudentAuth, handle(async (req, res) => {
    res.json(accessService.signMemberContract(req.studentMemberId, req.body || {}));
  }));

  router.use((_req, res) => {
    res.status(404).json({ error: 'Esta função não está disponível no servidor atual.', code: 'API_NOT_FOUND' });
  });
  return router;
}
