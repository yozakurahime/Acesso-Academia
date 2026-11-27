import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { AuthService } from '../src/services/authService.js';
import { createApiRouter } from '../src/routes/api.js';

test('AuthService configura senha, gera cookie assinado e protege rotas mantendo webhooks e catraca liberados', async () => {
  const store = await DatabaseStore.create(null);
  const auth = new AuthService(store);

  assert.equal(auth.isEnabled(), false);
  assert.throws(() => auth.configure({ enabled: true, username: 'admin', password: '' }), /Defina uma senha/);
  assert.throws(() => auth.configure({ enabled: true, username: 'admin', password: '123' }), /entre 8 e 128/);

  const cfg = auth.configure({ enabled: true, username: 'oxigenio', password: 'segredo-forte' });
  assert.equal(cfg.enabled, true);
  assert.equal(auth.isEnabled(), true);
  assert.equal(auth.authenticate('oxigenio', 'segredo-forte'), true);
  assert.equal(auth.authenticate('oxigenio', 'errada'), false);
  assert.equal(auth.authenticate('outro', 'segredo-forte'), false);

  const token = auth.signToken('oxigenio');
  assert.equal(auth.verifyToken(token)?.u, 'oxigenio');
  assert.equal(auth.verifyToken(`${token}x`), null);

  const mw = auth.middleware();
  const callMw = (path, cookie = '') =>
    new Promise((resolve) => {
      const req = { path, headers: cookie ? { cookie } : {} };
      const res = {
        statusCode: 200,
        body: null,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(obj) {
          this.body = obj;
          resolve({ nextCalled: false, statusCode: this.statusCode, body: obj });
        },
      };
      mw(req, res, () => resolve({ nextCalled: true, statusCode: 200, req }));
    });

  const blocked = await callMw('/members');
  assert.equal(blocked.nextCalled, false);
  assert.equal(blocked.statusCode, 401);
  assert.equal(blocked.body.code, 'AUTH_REQUIRED');

  const allowedWebhook = await callMw('/webhooks/asaas');
  assert.equal(allowedWebhook.nextCalled, true);

  const allowedTurnstile = await callMw('/new_user_identified.fcgi');
  assert.equal(allowedTurnstile.nextCalled, true);

  const allowedAuthed = await callMw('/members', `acesso_session=${encodeURIComponent(token)}`);
  assert.equal(allowedAuthed.nextCalled, true);
  assert.equal(allowedAuthed.req.authUser, 'oxigenio');
});

test('tela e atalho locais funcionam com login ativo e têm proteção de origem', async (t) => {
  const store = await DatabaseStore.create();
  const authService = new AuthService(store);
  authService.configure({ enabled: true, username: 'teste', password: 'senha-teste' });
  let releases = 0;
  const accessService = {
    getTurnstileDisplay: () => null,
    releaseTurnstile: async () => { releases++; return {}; },
  };
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService, accessService, hotkeyToken: 'token-teste' }));
  const server = await new Promise((resolve) => {
    const result = app.listen(0, '127.0.0.1', () => resolve(result));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;
  assert.equal((await fetch(base + '/turnstile/display')).status, 200);
  assert.equal((await fetch(base + '/turnstile/display', { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 403);
  assert.equal((await fetch(base + '/device/release', { method: 'POST' })).status, 401);
  assert.equal((await fetch(base + '/device/release', { method: 'POST', headers: { 'x-oxigenio-hotkey': 'token-teste' } })).status, 200);
  assert.equal(releases, 1);

  const statusUnauth = await (await fetch(base + '/auth/status')).json();
  assert.equal(statusUnauth.authenticated, false);
  assert.equal(statusUnauth.username, null);

  const loginRes = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'teste', password: 'senha-teste' }),
  });
  assert.equal(loginRes.status, 200);
  const adminCookie = loginRes.headers.get('set-cookie').split(';')[0];

  store.updateSettings({
    wellhub_api_key: 'wh-key',
    wellhub_webhook_secret: 'wh-sec',
    totalpass_api_token: 'tp-tok',
    totalpass_webhook_secret: 'tp-sec',
  });
  const settingsRes = await (await fetch(base + '/settings', { headers: { cookie: adminCookie } })).json();
  assert.equal(settingsRes.wellhub_api_key, '******');
  assert.equal(settingsRes.wellhub_webhook_secret, '******');
  assert.equal(settingsRes.totalpass_api_token, '******');
  assert.equal(settingsRes.totalpass_webhook_secret, '******');

  const badIpRes = await fetch(base + '/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ controlid_ip: '127.0.0.1' }),
  });
  assert.equal(badIpRes.status, 400);
});

test('AuthService suporta tempo de sessao, bloqueio por inatividade, lista de operadores e troca rapida (/api/auth/switch)', async (t) => {
  const store = await DatabaseStore.create();
  const authService = new AuthService(store);
  authService.configure({
    enabled: true,
    username: 'admin',
    password: 'senha-admin-forte',
    idleTimeoutMinutes: 15,
    sessionTtlHours: 24,
  });
  authService.createUser({ username: 'recepcao1', password: 'senha-recepcao-1', role: 'reception' });

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService }));
  const server = await new Promise((resolve) => {
    const result = app.listen(0, '127.0.0.1', () => resolve(result));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const status = await (await fetch(base + '/auth/status')).json();
  assert.equal(status.enabled, true);
  assert.equal(status.idleTimeoutMinutes, 15);
  assert.equal(status.sessionTtlHours, 24);
  assert.deepEqual(status.operators, []);

  // Login temporario (rememberSession: false) nao envia Max-Age
  const tempLogin = await fetch(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'senha-admin-forte', rememberSession: false }),
  });
  assert.equal(tempLogin.status, 200);
  const setCookieHeader = tempLogin.headers.get('set-cookie') || '';
  assert.doesNotMatch(setCookieHeader, /Max-Age=/i);
  const adminCookie = setCookieHeader.split(';')[0];

  // Troca de operador com senha errada falha sem derrubar sessao atual
  const badSwitch = await fetch(base + '/auth/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'recepcao1', password: 'errada' }),
  });
  assert.equal(badSwitch.status, 401);

  // Troca de operador valida atualiza cookie e retorna novo papel
  const goodSwitch = await fetch(base + '/auth/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ username: 'recepcao1', password: 'senha-recepcao-1' }),
  });
  assert.equal(goodSwitch.status, 200);
  const switchedBody = await goodSwitch.json();
  assert.equal(switchedBody.username, 'recepcao1');
  assert.equal(switchedBody.role, 'reception');
  const receptionCookie = (goodSwitch.headers.get('set-cookie') || '').split(';')[0];

  const switchedStatus = await (await fetch(base + '/auth/status', { headers: { cookie: receptionCookie } })).json();
  assert.equal(switchedStatus.authenticated, true);
  assert.equal(switchedStatus.username, 'recepcao1');
  assert.equal(switchedStatus.role, 'reception');
  assert.deepEqual(
    switchedStatus.operators.map((o) => `${o.username}:${o.role}`),
    ['admin:admin', 'recepcao1:reception'],
  );
});

test('AuthService assina e valida token temporario para envio de foto FaceID', async () => {
  const store = await DatabaseStore.create(null);
  const auth = new AuthService(store);
  const token = auth.signFaceUploadToken(42, 60_000);
  const verified = auth.verifyFaceUploadToken(token);
  assert.equal(verified?.memberId, 42);

  assert.equal(auth.verifyFaceUploadToken(`${token}tampered`), null);
  assert.equal(auth.verifyFaceUploadToken(auth.signStudentToken(42)), null);

  const pixToken = auth.signPixViewToken(99, 60_000);
  assert.equal(auth.verifyPixViewToken(pixToken)?.chargeId, 99);
  assert.equal(auth.verifyPixViewToken(`${pixToken}x`), null);
});

test('PIX publico funciona sem sessao admin com token assinado e /public/pix/:id/status retorna paid e charge', async (t) => {
  const store = await DatabaseStore.create(null);
  const authService = new AuthService(store);
  authService.configure({ enabled: true, username: 'admin', password: 'senha-admin-forte' });

  const memberId = store.run("INSERT INTO members (name, status) VALUES ('Aluno Pix', 'pending')").lastInsertRowid;
  const planId = store.get('SELECT id FROM plans LIMIT 1').id;
  const chargeId = store.run(
    `INSERT INTO gateway_charges (member_id, plan_id, provider, external_id, amount_cents, status, qr_code)
     VALUES (?, ?, 'mercadopago', 'mp-ext-1', 9900, 'pending', '000201PIXTEST')`,
    [memberId, planId],
  ).lastInsertRowid;

  let paidFlag = false;
  const gatewayService = {
    async createPixCharge({ member_id, plan_id }) {
      const id = store.run(
        `INSERT INTO gateway_charges (member_id, plan_id, provider, external_id, amount_cents, status, qr_code)
         VALUES (?, ?, 'mercadopago', 'mp-ext-enroll', 9900, 'pending', '000201PIXENROLL')`,
        [member_id, plan_id],
      ).lastInsertRowid;
      return { id, status: 'pending', qr_code: '000201PIXENROLL' };
    },
    async checkChargeStatus(id) {
      const row = store.get('SELECT * FROM gateway_charges WHERE id = ?', [Number(id)]);
      return paidFlag
        ? { paid: true, charge: { ...row, status: 'paid', paid_at: '2026-11-27 10:00:00' } }
        : { paid: false, charge: row };
    },
  };

  const accessService = {
    async createMember({ name, phone, document, modality_id, plan_id, status }) {
      const id = store.run(
        "INSERT INTO members (name, phone, document, modality_id, plan_id, status) VALUES (?, ?, ?, ?, ?, ?)",
        [name, phone, document, modality_id, plan_id, status || 'pending'],
      ).lastInsertRowid;
      return store.get('SELECT * FROM members WHERE id = ?', [id]);
    },
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService, accessService, gatewayService }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const token = authService.signPixViewToken(chargeId, 60_000);
  const wrongToken = authService.signPixViewToken(chargeId + 999, 60_000);

  // /public/pix-charge sem cookie admin funciona com token valido e rejeita invalido
  const chargeBad = await fetch(`${base}/public/pix-charge?t=invalid`);
  assert.equal(chargeBad.status, 401);

  const chargeOk = await fetch(`${base}/public/pix-charge?t=${encodeURIComponent(token)}`);
  assert.equal(chargeOk.status, 200);
  const chargeBody = await chargeOk.json();
  assert.equal(chargeBody.id, chargeId);
  assert.equal(chargeBody.member_name, 'Aluno Pix');
  assert.equal(chargeBody.qr_code, '000201PIXTEST');

  // /public/pix-charge/check sem cookie admin funciona com token valido
  const checkPending = await fetch(`${base}/public/pix-charge/check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  assert.equal(checkPending.status, 200);
  assert.deepEqual(await checkPending.json(), { paid: false, status: 'pending' });

  // /public/pix/:id/status exige token correspondente e le result.paid / result.charge
  assert.equal((await fetch(`${base}/public/pix/${chargeId}/status`)).status, 401);
  assert.equal((await fetch(`${base}/public/pix/${chargeId}/status?t=${encodeURIComponent(wrongToken)}`)).status, 401);

  const statusPending = await fetch(`${base}/public/pix/${chargeId}/status?t=${encodeURIComponent(token)}`);
  assert.equal(statusPending.status, 200);
  assert.deepEqual(await statusPending.json(), {
    id: chargeId,
    status: 'pending',
    paid: false,
    paid_at: null,
  });

  paidFlag = true;
  const statusPaid = await fetch(`${base}/public/pix/${chargeId}/status?t=${encodeURIComponent(token)}`);
  assert.equal(statusPaid.status, 200);
  assert.deepEqual(await statusPaid.json(), {
    id: chargeId,
    status: 'paid',
    paid: true,
    paid_at: '2026-11-27 10:00:00',
  });

  // Fluxo /public/enroll retorna pixStatusToken para polling no /matricula
  const enrollRes = await fetch(`${base}/public/enroll`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Novo Aluno Pix',
      phone: '62998887766',
      plan_id: planId,
      modality_name: 'Musculação',
    }),
  });
  assert.equal(enrollRes.status, 201);
  const enrollBody = await enrollRes.json();
  assert.ok(enrollBody.pixCharge?.id);
  assert.ok(enrollBody.pixStatusToken);
  const enrollPollRes = await fetch(
    `${base}/public/pix/${enrollBody.pixCharge.id}/status?t=${encodeURIComponent(enrollBody.pixStatusToken)}`,
  );
  assert.equal(enrollPollRes.status, 200);
  const enrollPollBody = await enrollPollRes.json();
  assert.equal(enrollPollBody.id, enrollBody.pixCharge.id);
  assert.equal(enrollPollBody.paid, true);
});

test('RBAC protege rotas de recepcao/financeiro contra anonimo e instructor mantendo lista sanitizada para instructor', async (t) => {
  const store = await DatabaseStore.create(null);
  const authService = new AuthService(store);
  authService.configure({ enabled: true, username: 'admin', password: 'senha-admin-forte' });
  authService.createUser({ username: 'recep1', password: 'senha-recep-123', role: 'reception' });
  authService.createUser({ username: 'prof1', password: 'senha-prof-123', role: 'instructor' });

  const memberId = store.run(
    "INSERT INTO members (name, document, phone, status, access_role) VALUES ('Maria Teste', '12345678901', '62999990000', 'active', 'student')",
  ).lastInsertRowid;

  const accessService = {
    getDashboardSummary: () => ({ active_members: 1, revenue_today_cents: 1000 }),
    listMembers: () => [
      {
        id: memberId,
        name: 'Maria Teste',
        document: '12345678901',
        phone: '62999990000',
        access_role: 'student',
        status: 'active',
        access_status: 'active',
        modality_name: 'Musculação',
        plan_name: 'Mensal',
        face_registered: 0,
        open_debt_cents: 5000,
      },
    ],
  };
  const gymService = {
    getMemberProfile: (id) => ({ member: { id: Number(id), name: 'Maria Teste', document: '12345678901' }, payments: [] }),
  };
  const whatsappService = {
    getStatus: () => ({ connected: false }),
    listLogs: () => [],
  };

  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter({ store, authService, accessService, gymService, whatsappService }));
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
  });
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}/api`;

  const instCookie = `acesso_session=${encodeURIComponent(authService.signToken('prof1', 'instructor'))}`;
  const recepCookie = `acesso_session=${encodeURIComponent(authService.signToken('recep1', 'reception'))}`;

  const receptionOnlyPaths = [
    '/dashboard',
    `/members/${memberId}/profile`,
    '/logs',
    '/partners/checkins',
    '/whatsapp/status',
    '/whatsapp/logs',
  ];

  for (const p of receptionOnlyPaths) {
    assert.equal((await fetch(base + p)).status, 401, `${p} deve exigir autenticacao`);
    assert.equal((await fetch(base + p, { headers: { cookie: instCookie } })).status, 403, `${p} deve bloquear instructor`);
    assert.equal((await fetch(base + p, { headers: { cookie: recepCookie } })).status, 200, `${p} deve liberar reception`);
  }

  // /members: 401 para anonimo, 200 sanitizado para instructor, 200 completo para reception
  assert.equal((await fetch(`${base}/members`)).status, 401);
  const instMembersRes = await fetch(`${base}/members`, { headers: { cookie: instCookie } });
  assert.equal(instMembersRes.status, 200);
  const instMembers = await instMembersRes.json();
  assert.equal(instMembers.length, 1);
  assert.equal(instMembers[0].name, 'Maria Teste');
  assert.equal(instMembers[0].document, undefined);
  assert.equal(instMembers[0].phone, undefined);
  assert.equal(instMembers[0].open_debt_cents, undefined);

  const recepMembersRes = await fetch(`${base}/members`, { headers: { cookie: recepCookie } });
  assert.equal(recepMembersRes.status, 200);
  const recepMembers = await recepMembersRes.json();
  assert.equal(recepMembers[0].document, '12345678901');
});
