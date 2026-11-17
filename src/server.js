import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cron from 'node-cron';
import { DatabaseStore } from './db.js';
import { ControlIdClient } from './services/controlIdClient.js';
import { ToletusClient } from './services/toletusClient.js';
import { AccessService } from './services/accessService.js';
import { GymService } from './services/gymService.js';
import { ImportService } from './services/importService.js';
import { WhatsappService } from './services/whatsappService.js';
import { WhatsappBotService } from './services/whatsappBotService.js';
import { ReceiptService } from './services/receiptService.js';
import { GatewayService } from './services/gatewayService.js';
import { AuthService } from './services/authService.js';
import { StudentPortalService } from './services/studentPortalService.js';
import { startGlobalHotkey } from './services/globalHotkey.js';
import { createDesktopNotifier } from './services/desktopNotifier.js';
import { startCloudflareTunnel } from './services/tunnelService.js';
import { createApiRouter } from './routes/api.js';
import { ExerciseVideos } from './services/exerciseVideos.js';
import { DeviceService } from './services/deviceService.js';
import { FinanceService } from './services/financeService.js';
import { BackupService } from './services/backupService.js';
import { GoogleDriveBackupService } from './services/googleDriveBackupService.js';
import { EdgeCloudHub, EdgeSyncClient } from './services/edgeSyncService.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function start() {
  const dataDir = path.resolve(rootDir, process.env.DATA_DIR || './data');
  const dbPath = path.join(dataDir, 'acesso.sqlite');

  const store = await DatabaseStore.create(dbPath);
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId, toletus);
  const gymService = new GymService(store);
  const importService = new ImportService(store, controlId);
  const whatsappService = new WhatsappService(store, { authDir: path.join(dataDir, 'whatsapp-auth') });
  const whatsappBotService = new WhatsappBotService(store);
  const receiptService = new ReceiptService(store, accessService, { whatsappService });
  const gatewayService = new GatewayService(store, accessService, { whatsappService });
  const authService = new AuthService(store);
  const studentPortalService = new StudentPortalService(store, gymService);
  const financeService = new FinanceService(store);
  const backupService = new BackupService(store, path.join(dataDir, 'backups'));
  const googleDriveBackupService = new GoogleDriveBackupService(store);
  const edgeRole = String(process.env.EDGE_ROLE || 'standalone').trim().toLowerCase();
  const edgeCloudHub = new EdgeCloudHub(store);
  whatsappService.setReceiptHandler((payload) => receiptService.processReceipt(payload));
  whatsappService.setBotHandler(whatsappBotService);

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });
  const port = Number(process.env.PORT || 3000);
  const callbackPort = Number(process.env.CONTROLID_CALLBACK_PORT || 81);
  const deviceService = new DeviceService(store, controlId, toletus);
  const callbackOrigin = (req, res, next) => {
    const settings = store.getSettings();
    const remote = req.socket.remoteAddress?.replace(/^::ffff:/, '');
    const allowedIps = deviceService.getAllowedCallbackIps();
    const isAllowed = Boolean(remote) && (allowedIps.has(remote) || remote === String(settings.controlid_ip || '').trim());
    if (!isAllowed ||
        req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip']) {
      return res.status(403).json({ error: 'Origem do leitor não autorizada.' });
    }
    const expectedToken = String(settings.controlid_callback_token || process.env.CONTROLID_CALLBACK_TOKEN || '').trim();
    if (expectedToken) {
      const provided = String(req.get('x-controlid-token') || req.query?.token || '');
      const a = Buffer.from(provided);
      const b = Buffer.from(expectedToken);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return res.status(403).json({ error: 'Token do leitor inválido.' });
      }
    }
    next();
  };
  const callbackPaths = ['/api/new_user_identified.fcgi', '/api/controlid/new_user_identified.fcgi',
    '/new_user_identified.fcgi', '/api/device_is_alive.fcgi', '/device_is_alive.fcgi'];
  app.post(callbackPaths, (req, res, next) => {
    if (callbackPort && callbackPort !== port) return res.sendStatus(404);
    callbackOrigin(req, res, next);
  });
  const uploadJsonParser = express.json({ limit: '15mb' });
  app.post(['/api/receipts/analyze', '/api/members/:id/face', '/api/import/sca'], uploadJsonParser);
  app.put('/api/student/me/photo', uploadJsonParser);
  app.post(
    ['/api/webhooks/wellhub', '/api/webhooks/totalpass', '/api/webhooks/mercadopago', '/api/webhooks/payment'],
    express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }),
  );
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));
  const studentPortalUrl = String(process.env.STUDENT_PORTAL_URL || 'https://academiaoxigenio.com/aluno').trim();
  const studentPortalHost = String(process.env.STUDENT_PORTAL_HOST || 'academiaoxigenio.com').trim().toLowerCase();
  const adminHost = String(process.env.ADMIN_HOST || 'sistema.academiaoxigenio.com').trim().toLowerCase();
  const getReqHost = (req) => String(req.hostname || req.headers.host || '').split(':')[0].trim().toLowerCase();
  const isStudentPortalHost = (req) => {
    const rawHost = getReqHost(req);
    return Boolean(rawHost) && (
      rawHost === studentPortalHost
      || rawHost === `www.${studentPortalHost}`
      || rawHost === 'academiaoxigenio.com'
      || rawHost === 'www.academiaoxigenio.com'
      || rawHost.startsWith('aluno.')
    );
  };
  const isAdminRemoteHost = (req) => {
    const rawHost = getReqHost(req);
    return Boolean(rawHost) && (rawHost === adminHost || rawHost.startsWith('sistema.'));
  };
  const STUDENT_HOST_ASSETS = new Set([
    '/', '/aluno', '/aluno/', '/aluno.html', '/aluno.css', '/aluno.js', '/styles.css',
    '/exercises.js', '/exercise-catalog.js', '/oxigenio.jpg', '/manifest.json', '/sw.js', '/favicon.ico',
  ]);
  app.use((req, res, next) => {
    const isAlunoPath = req.path === '/aluno' || req.path === '/aluno/' || req.path === '/aluno.html';
    if (isAdminRemoteHost(req) && isAlunoPath) {
      return res.redirect(302, studentPortalUrl);
    }
    if (!isStudentPortalHost(req)) {
      if (req.method === 'GET' && (req.path === '/aluno' || req.path === '/aluno/')) {
        return res.sendFile(path.join(rootDir, 'public', 'aluno.html'));
      }
      return next();
    }
    const rawHost = getReqHost(req);
    if (rawHost.startsWith('aluno.') && (req.path === '/' || req.path === '/index.html')) {
      return res.redirect(302, studentPortalUrl);
    }
    if (isAlunoPath) {
      return res.sendFile(path.join(rootDir, 'public', 'aluno.html'));
    }
    if (req.path === '/' || req.path === '/index.html') {
      const landingFile = path.join(rootDir, 'public', 'landing.html');
      return res.sendFile(fs.existsSync(landingFile) ? landingFile : path.join(rootDir, 'public', 'aluno.html'));
    }
    if (req.path.startsWith('/api/student/') || req.path === '/api/health' || /^\/api\/exercise-catalog\/[^/]+\/video$/.test(req.path)) {
      return next();
    }
    if (req.method === 'GET' && (STUDENT_HOST_ASSETS.has(req.path) || req.path.startsWith('/landing-assets/') || req.path.startsWith('/icons/'))) {
      return next();
    }
    return res.status(404).json({ error: 'Rota indisponível no portal do aluno.' });
  });

  const hotkeyToken = randomBytes(32).toString('hex');
  const exerciseVideos = new ExerciseVideos(store, path.join(dataDir, 'exercise-videos'));
  app.use(['/new_user_identified.fcgi', '/device_is_alive.fcgi'], (req, _res, next) => {
    if (req.method === 'POST') req.url = `/api${req.path}`;
    next();
  });
  app.use('/api', createApiRouter({ store, controlId, toletus, accessService, gymService, importService, whatsappService, whatsappBotService, receiptService, gatewayService, authService, studentPortalService, googleDriveBackupService, hotkeyToken, exerciseVideos, dataDir, edgeCloudHub }));
  app.use(express.static(path.join(rootDir, 'public'), {
    setHeaders(res, filePath) {
      if (/\.(html|js|css)$/i.test(filePath)) {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  }));
  app.use((err, _req, res, _next) => {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) console.error('[HTTP ERROR]', err);
    res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : (err.message || 'Requisição inválida.') });
  });

  // Job diario as 00:05 e verificacao inicial ao ligar o PC
  const runExpirationCheck = async (label) => {
    try {
      const blocked = await accessService.checkExpiredMembers();
      if (blocked.length > 0) {
        console.log(`[${label}] ${blocked.length} cliente(s) bloqueado(s) por vencimento.`);
      }
      const removedFromClasses = accessService.removeOverdueClassEnrollments(5);
      if (removedFromClasses.length > 0) {
        for (const item of removedFromClasses) {
          await whatsappService.enqueueClassRemovalNotice({
            member: item,
            removedClasses: item.removedClasses,
            graceDays: 5,
          }).catch(() => {});
        }
        console.log(`[${label}] ${removedFromClasses.length} aluno(s) removido(s) da turma após 5 dias de tolerância.`);
      }
    } catch (err) {
      console.error(`[${label}] Erro ao verificar vencimentos:`, err.message);
    }
  };
  cron.schedule('5 0 * * *', () => runExpirationCheck('CRON'));
  runExpirationCheck('STARTUP');

  cron.schedule('15 9-19 * * *', () => {
    whatsappService.runScheduledCampaigns().catch((err) => {
      console.error('[WHATSAPP CRON]', err.message);
    });
  });

  cron.schedule('0 9 * * *', () => {
    if (store.getSettings().auto_collection_enabled === '1') {
      financeService.runAutoCollection(whatsappService).catch((err) => {
        console.error('[AUTO COLLECTION CRON]', err.message);
      });
    }
  });

  cron.schedule('30 21 * * *', async () => {
    try {
      const backup = backupService.createBackup();
      await googleDriveBackupService.syncBackup(backup).catch((err) => {
        console.error('[GDRIVE BACKUP CRON]', err.message);
      });
    } catch (err) {
      console.error('[BACKUP CRON]', err.message);
    }
  });
  if (whatsappService.hasSavedSession()) {
    whatsappService.connect().catch((err) => {
      console.error('[WHATSAPP STARTUP]', err.message);
    });
  }

  let tunnelHandle = { stop() {} };
  let desktopNotifier = { stop() {} };
  let unsubscribeDesktopNotifier = () => {};
  let edgeSyncClient = null;
  const mainServer = app.listen(port, '0.0.0.0', () => {
    console.log(`Sistema de Academia rodando em http://localhost:${port} (modo: ${edgeRole})`);
    console.log(`Banco de dados local: ${dbPath}`);
    startGlobalHotkey(rootDir, port, hotkeyToken);
    desktopNotifier = createDesktopNotifier({ rootDir, port });
    unsubscribeDesktopNotifier = accessService.onTurnstileRelease((event) => {
      desktopNotifier.notifyTurnstileRelease(event);
      if (edgeSyncClient) {
        edgeSyncClient.pushPendingLogs().catch(() => {});
      }
    });
    if (edgeRole === 'edge' && process.env.EDGE_CLOUD_URL && process.env.EDGE_SYNC_TOKEN) {
      edgeSyncClient = new EdgeSyncClient({
        store,
        accessService,
        cloudUrl: process.env.EDGE_CLOUD_URL,
        token: process.env.EDGE_SYNC_TOKEN,
      });
      edgeSyncClient.start();
      console.log(`[EDGE SYNC] Conectado ao servidor cloud: ${process.env.EDGE_CLOUD_URL}`);
    }
    tunnelHandle = startCloudflareTunnel();
    if (process.platform === 'win32' && process.env.OXIGENIO_ABRIR_TELAS === '1') {
      const launcher = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(rootDir, 'scripts', 'abrir-telas.ps1'), '-Port', String(port),
      ], { windowsHide: true, stdio: 'inherit' });
      launcher.on('error', (err) => console.warn('[TELAS]', err.message));
      launcher.unref();
    }
  });

  // Porta secundaria (81) isolada apenas para callbacks do Control iD Modo Online
  let callbackServer = null;
  if (callbackPort && callbackPort !== port) {
    const callbackApp = express();
    callbackApp.disable('x-powered-by');
    callbackApp.use(callbackOrigin);
    callbackApp.use(express.json({ limit: '1mb' }));
    callbackApp.use(express.urlencoded({ extended: true }));

    const handleDeviceAlive = (_req, res) => res.json({ ok: true });
    const handleIdentified = async (req, res) => {
      try {
        const rawUserId = req.body?.user_id ?? req.query?.user_id;
        const userId = Number(rawUserId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return res.status(400).json({ error: 'user_id inválido.' });
        }
        const readerIp = req.socket?.remoteAddress || req.ip || null;
        const readerId = req.query?.reader_id || req.body?.reader_id || null;
        const result = await accessService.handleFaceIdentified(userId, { readerIp, readerId });
        res.json({
          result: {
            event: result.event ?? (result.allowed ? 7 : 6),
            user_id: userId,
            user_name: result.member?.name || '',
            user_image: false,
            portal_id: Number(req.body?.portal_id ?? req.query?.portal_id ?? 1),
            actions: [],
            message: result.message,
          },
        });
      } catch (err) {
        const status = err.statusCode || 400;
        if (status >= 500) console.error('[CALLBACK ERROR]', err);
        res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : err.message });
      }
    };

    callbackApp.post('/api/new_user_identified.fcgi', handleIdentified);
    callbackApp.post('/api/controlid/new_user_identified.fcgi', handleIdentified);
    callbackApp.post('/new_user_identified.fcgi', handleIdentified);
    callbackApp.post('/api/device_is_alive.fcgi', handleDeviceAlive);
    callbackApp.post('/device_is_alive.fcgi', handleDeviceAlive);
    callbackApp.use((err, _req, res, _next) => {
      const status = err.statusCode || err.status || 500;
      if (status >= 500) console.error('[CALLBACK HTTP ERROR]', err);
      res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor.' : (err.message || 'Requisição inválida.') });
    });

    callbackServer = callbackApp.listen(callbackPort, '0.0.0.0', () => {
      console.log(`Callback Control iD Modo Online (isolado) ativo na porta ${callbackPort}`);
    });
    callbackServer.on('error', (err) => {
      console.warn(`[Control iD Callback] Porta ${callbackPort} indisponivel (${err.code || err.message}).`);
    });
  }

  const shutdown = () => {
    try { edgeSyncClient?.stop(); } catch {}
    try { unsubscribeDesktopNotifier(); } catch {}
    try { desktopNotifier.stop(); } catch {}
    try { tunnelHandle.stop(); } catch {}
    try { store.save(); } catch {}
    whatsappService.disconnect({ clearSession: false }).catch(() => {});
    mainServer.close();
    if (callbackServer) callbackServer.close();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

start().catch((err) => {
  console.error('Falha ao iniciar servidor:', err);
  process.exit(1);
});
