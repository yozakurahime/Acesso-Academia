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

  await assert.rejects(
    accessService.createMember({
      name: 'Sem Wellhub ID',
      document: '52998224725',
      partner_provider: 'wellhub',
    }),
    { statusCode: 400, message: /ID do Wellhub/ },
  );

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
  assert.match(whDenied.message, /Check-in Wellhub pendente/);

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
  assert.match(denied.message, /Check-in TotalPass pendente/);

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
