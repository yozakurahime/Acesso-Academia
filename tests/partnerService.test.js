import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { ToletusClient } from '../src/services/toletusClient.js';
import { AccessService } from '../src/services/accessService.js';
import { GymService } from '../src/services/gymService.js';
import { PartnerService } from '../src/services/partnerService.js';

async function createEnv() {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true', toletus_enabled: 'false' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const toletus = new ToletusClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId, toletus);
  const gymService = new GymService(store);
  return { store, accessService, gymService };
}

test('Wellhub e TotalPass liberam catraca sem matrícula ativa e validam ID Wellhub único', async () => {
  const { store, accessService, gymService } = await createEnv();
  store.updateSettings({ wellhub_require_checkin: '0', totalpass_require_checkin: '0' });

  const wellhubWithoutId = await accessService.createMember({
    name: 'Sem Wellhub ID',
    document: '12345678909',
    partner_provider: 'wellhub',
  });
  assert.equal(wellhubWithoutId.status, 'active');
  assert.equal(wellhubWithoutId.partner_provider, 'wellhub');
  assert.equal(wellhubWithoutId.wellhub_id, null);
  const noIdAccess = await accessService.handleFaceIdentified(wellhubWithoutId.controlid_user_id);
  assert.equal(noIdAccess.allowed, true);

  const wellhubMember = await accessService.createMember({
    name: 'Carlos Wellhub',
    document: '52998224725',
    partner_provider: 'wellhub',
    wellhub_id: 'WH-998877',
  });
  assert.equal(wellhubMember.status, 'active');
  assert.equal(wellhubMember.partner_provider, 'wellhub');
  assert.equal(wellhubMember.wellhub_id, 'WH-998877');
  assert.equal(wellhubMember.plan_id, null);

  await assert.rejects(
    accessService.createMember({
      name: 'Duplicado Wellhub',
      document: '11144477735',
      partner_provider: 'wellhub',
      wellhub_id: 'wh-998877',
    }),
    { statusCode: 409, message: /ID Wellhub/ },
  );

  const totalpassMember = await accessService.createMember({
    name: 'Mariana TotalPass',
    document: '11144477735',
    partner_provider: 'totalpass',
  });
  assert.equal(totalpassMember.status, 'active');
  assert.equal(totalpassMember.partner_provider, 'totalpass');
  assert.equal(totalpassMember.plan_id, null);

  // Ambos entram pela catraca sem matrícula paga
  const whAccess = await accessService.handleFaceIdentified(wellhubMember.controlid_user_id);
  assert.equal(whAccess.allowed, true);
  const tpAccess = await accessService.handleFaceIdentified(totalpassMember.controlid_user_id);
  assert.equal(tpAccess.allowed, true);

  // Bloqueio manual suspende o acesso mesmo sendo convênio
  store.run("UPDATE members SET status = 'blocked' WHERE id = ?", [totalpassMember.id]);
  const blockedAccess = await accessService.handleFaceIdentified(totalpassMember.controlid_user_id);
  assert.equal(blockedAccess.allowed, false);
  assert.equal(blockedAccess.message, 'Acesso suspenso');

  // Edição permite vincular convênio posteriormente e ativa cadastro pendente
  const regularPending = await accessService.createMember({ name: 'Aluno Pendente', document: '39053344705' });
  assert.equal(regularPending.status, 'pending');
  const promoted = gymService.updateMember(regularPending.id, { partner_provider: 'totalpass' });
  assert.equal(promoted.member.status, 'active');

  // Aluno já cadastrado sem CPF pode ser vinculado ao Wellhub sem exigir CPF
  const legacyIns = store.run("INSERT INTO members (name, access_role, status) VALUES ('Aluno Legado Sem CPF', 'student', 'pending')");
  const legacyPromoted = gymService.updateMember(legacyIns.lastInsertRowid, {
    document: '',
    partner_provider: 'wellhub',
    wellhub_id: '',
  });
  assert.equal(legacyPromoted.member.partner_provider, 'wellhub');
  assert.equal(legacyPromoted.member.status, 'active');
  assert.equal(legacyPromoted.member.document, null);
  assert.equal(promoted.member.partner_provider, 'totalpass');
});

test('Wellhub webhook e TotalPass check-in liberam catraca quando exigência de check-in diário está ativa', async () => {
  const { store, accessService } = await createEnv();
  store.updateSettings({
    wellhub_require_checkin: '1',
    wellhub_webhook_secret: 'segredo-wh',
    totalpass_require_checkin: '1',
    totalpass_api_token: 'tp-token',
    totalpass_gym_id: 'gym-1',
  });

  const wh = await accessService.createMember({
    name: 'João Wellhub',
    document: '52998224725',
    partner_provider: 'wellhub',
    wellhub_id: 'GYM-12345',
  });
  const tp = await accessService.createMember({
    name: 'Ana TotalPass',
    document: '11144477735',
    partner_provider: 'totalpass',
  });

  // Sem check-in hoje -> catraca nega
  const whDenied = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(whDenied.allowed, false);
  assert.match(whDenied.message, /Aguarde a liberação na recepção \(Wellhub\)/);

  // Webhook Wellhub registra check-in do dia
  const partnerSvc = new PartnerService(store, async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: 'tp-chk-1' }),
  }));
  assert.throws(
    () => partnerSvc.handleWellhubWebhook({ gympass_id: 'GYM-12345' }, { 'x-wellhub-signature': 'errado' }),
    { statusCode: 401 },
  );
  const webhookRes = partnerSvc.handleWellhubWebhook({ gympass_id: 'GYM-12345' }, { 'x-wellhub-signature': 'segredo-wh' });
  assert.equal(webhookRes.matched, true);
  assert.equal(webhookRes.member_id, wh.id);

  // Agora Wellhub entra!
  const whAllowed = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(whAllowed.allowed, true);

  // TotalPass sem check-in -> registra via PartnerService (API mockada) e entra
  const tpRes = await partnerSvc.registerMemberCheckin({ memberId: tp.id, source: 'manual' });
  assert.equal(tpRes.checkin.source, 'api');
  assert.equal(tpRes.checkin.identifier, '11144477735');
  const tpAllowed = await accessService.handleFaceIdentified(tp.controlid_user_id);
  assert.equal(tpAllowed.allowed, true);
});

test('Webhook TotalPass confirma endpoint oficial, registra check-in por CPF e libera catraca', async () => {
  const { store, accessService } = await createEnv();
  store.updateSettings({ totalpass_require_checkin: '1' });

  const tp = await accessService.createMember({
    name: 'Lucas TotalPass',
    document: '39053344705',
    partner_provider: 'totalpass',
  });

  const denied = await accessService.handleFaceIdentified(tp.controlid_user_id);
  assert.equal(denied.allowed, false);
  assert.match(denied.message, /Aguarde a liberação na recepção \(TotalPass\)/);

  let confirmedUrl = null;
  const partnerSvc = new PartnerService(store, async (url) => {
    confirmedUrl = url;
    return { ok: true, status: 200, json: async () => ({}) };
  });

  // Sem segredo configurado -> falha fechada (503)
  await assert.rejects(
    () => partnerSvc.handleTotalpassWebhook({ cpf: '390.533.447-05' }, {}),
    { statusCode: 503 },
  );

  store.updateSettings({ totalpass_webhook_secret: 'segredo-tp' });
  await assert.rejects(
    () => partnerSvc.handleTotalpassWebhook({ cpf: '390.533.447-05' }, { 'x-totalpass-signature': 'errado' }),
    { statusCode: 401 },
  );

  const whRes = await partnerSvc.handleTotalpassWebhook(
    {
      cpf: '390.533.447-05',
      endpoint: 'https://gym-service-api.totalpass.com/webhook_confirmations/token-teste-123',
    },
    { 'x-totalpass-signature': 'segredo-tp' },
  );
  assert.equal(whRes.matched, true);
  assert.equal(whRes.confirmed, true);
  assert.equal(confirmedUrl, 'https://gym-service-api.totalpass.com/webhook_confirmations/token-teste-123');

  const allowed = await accessService.handleFaceIdentified(tp.controlid_user_id);
  assert.equal(allowed.allowed, true);
});

test('Convênio bloqueia por padrão e gera notificação persistente até recepção liberar por 1 dia ou cancelar', async () => {
  const { store, accessService } = await createEnv();
  const events = [];
  const unsub = accessService.onPartnerRequest((type, payload) => events.push({ type, payload }));

  const wh = await accessService.createMember({
    name: 'Carla Convênio',
    document: '52998224725',
    partner_provider: 'wellhub',
    wellhub_id: 'WH-DIA-01',
  });

  // 1a tentativa na catraca: bloqueia e cria 1 notificação pendente
  const firstTry = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(firstTry.allowed, false);
  assert.equal(firstTry.message, 'Aguarde a liberação na recepção (Wellhub)');
  assert.equal(accessService.listPendingPartnerRequests().length, 1);

  // 2a tentativa enquanto aguarda: continua bloqueado sem duplicar notificação
  const secondTry = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(secondTry.allowed, false);
  const pending = accessService.listPendingPartnerRequests();
  assert.equal(pending.length, 1);

  // Recepção aprova para hoje -> libera catraca e remove da fila pendente
  const approved = await accessService.approvePartnerRequest(pending[0].id);
  assert.equal(approved.approved, true);
  assert.equal(accessService.listPendingPartnerRequests().length, 0);

  // Hoje passa direto na catraca
  const allowedToday = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(allowedToday.allowed, true);

  // Simula virada da meia-noite (check-in foi ontem) -> volta a bloquear e pede nova liberação
  store.run("UPDATE partner_checkins SET checkin_date = date('now', 'localtime', '-1 day') WHERE member_id = ?", [wh.id]);
  const nextDayTry = await accessService.handleFaceIdentified(wh.controlid_user_id);
  assert.equal(nextDayTry.allowed, false);
  assert.equal(nextDayTry.message, 'Aguarde a liberação na recepção (Wellhub)');
  const pendingNextDay = accessService.listPendingPartnerRequests();
  assert.equal(pendingNextDay.length, 1);

  // Recepção cancela -> notificação some e acesso continua bloqueado
  const cancelled = accessService.cancelPartnerRequest(pendingNextDay[0].id);
  assert.equal(cancelled.cancelled, true);
  assert.equal(accessService.listPendingPartnerRequests().length, 0);
  assert.ok(events.some((e) => e.type === 'partner_request'));
  assert.ok(events.some((e) => e.type === 'partner_request_resolved' && e.payload.status === 'approved'));
  assert.ok(events.some((e) => e.type === 'partner_request_resolved' && e.payload.status === 'cancelled'));
  unsub();
});

test('RBAC: /partner-requests/:id/approve e /cancel exigem recepcao/admin', async (t) => {
  const { default: express } = await import('express');
  const { AuthService } = await import('../src/services/authService.js');
  const { createApiRouter } = await import('../src/routes/api.js');

  const store = await DatabaseStore.create(null);
  const authService = new AuthService(store);
  authService.configure({ enabled: true, username: 'admin', password: 'admin-password-123' });

  let approvedId = null;
  let cancelledId = null;
  const accessService = {
    approvePartnerRequest: async (id) => {
      approvedId = id;
      return { ok: true, id };
    },
    cancelPartnerRequest: (id) => {
      cancelledId = id;
      return { ok: true, id };
    },
  };

  const app = express();
  app.use(express.json());
  app.use('/api', authService.middleware());
  app.use('/api', createApiRouter({ store, authService, accessService }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());

  const base = `http://127.0.0.1:${server.address().port}/api`;
  authService.createUser({ username: 'inst', password: 'inst-password-123', role: 'instructor' });
  authService.createUser({ username: 'recep', password: 'recep-password-123', role: 'reception' });
  const instToken = authService.signToken('inst', 'instructor');
  const recepToken = authService.signToken('recep', 'reception');

  const unauthApprove = await fetch(`${base}/partner-requests/10/approve`, { method: 'POST' });
  assert.equal(unauthApprove.status, 401);

  const instApprove = await fetch(`${base}/partner-requests/10/approve`, {
    method: 'POST',
    headers: { Cookie: `acesso_session=${encodeURIComponent(instToken)}` },
  });
  assert.equal(instApprove.status, 403);

  const instCancel = await fetch(`${base}/partner-requests/10/cancel`, {
    method: 'POST',
    headers: { Cookie: `acesso_session=${encodeURIComponent(instToken)}` },
  });
  assert.equal(instCancel.status, 403);

  const recepApprove = await fetch(`${base}/partner-requests/10/approve`, {
    method: 'POST',
    headers: { Cookie: `acesso_session=${encodeURIComponent(recepToken)}` },
  });
  assert.equal(recepApprove.status, 200);
  assert.equal(approvedId, '10');

  const recepCancel = await fetch(`${base}/partner-requests/11/cancel`, {
    method: 'POST',
    headers: { Cookie: `acesso_session=${encodeURIComponent(recepToken)}` },
  });
  assert.equal(recepCancel.status, 200);
  assert.equal(cancelledId, '11');
});
