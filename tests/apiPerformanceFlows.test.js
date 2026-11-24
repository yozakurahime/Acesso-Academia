import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { GymService } from '../src/services/gymService.js';
import { AuthService } from '../src/services/authService.js';
import { createApiRouter } from '../src/routes/api.js';

async function createSlowControlIdTestServer({ syncDelayMs = 250 } = {}) {
  const store = await DatabaseStore.create(null);
  const syncCalls = [];
  const deleteCalls = [];
  const controlId = {
    async syncMember(member, allowed, options) {
      await new Promise((r) => setTimeout(r, syncDelayMs));
      syncCalls.push({ id: member.id, name: member.name, allowed, options });
      return { controlIdUserId: member.controlid_user_id || member.id, allowed, mock: true };
    },
    async deleteUser(deviceUserId) {
      await new Promise((r) => setTimeout(r, syncDelayMs));
      deleteCalls.push(deviceUserId);
      return { ok: true };
    },
  };

  const accessService = new AccessService(store, controlId);
  const gymService = new GymService(store);
  const authService = new AuthService(store);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.authUser = 'admin-test';
    req.authRole = 'admin';
    next();
  });
  app.use('/api', createApiRouter({
    store,
    controlId,
    accessService,
    gymService,
    authService,
  }));

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api`;

  async function request(path, options = {}) {
    const t0 = performance.now();
    const res = await fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
    });
    const elapsedMs = performance.now() - t0;
    const body = await res.json().catch(() => null);
    return { status: res.status, body, elapsedMs };
  }

  return {
    store,
    accessService,
    syncCalls,
    deleteCalls,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('API fluxos interativos (matricula, pagamento, status, edicao e exclusao) nao bloqueiam em Control iD lento', async () => {
  const env = await createSlowControlIdTestServer({ syncDelayMs: 400 });
  try {
    const plans = env.accessService.listPlans();
    const mensal = plans.find((p) => p.duration_days > 1 && p.price_cents > 0);
    assert.ok(mensal);

    // 1. POST /api/members nao aguarda Control iD e retorna resumo completo
    const created = await env.request('/members', {
      method: 'POST',
      body: JSON.stringify({ name: 'Aluno Rapido', document: '52998224725', plan_id: mensal.id }),
    });
    assert.equal(created.status, 201);
    assert.ok(created.body?.id);
    assert.equal(created.body.access_status, 'pending');
    assert.ok(created.body.next_charge?.id);
    assert.ok(created.elapsedMs < 300, `POST /members demorou ${created.elapsedMs}ms`);

    // 2. PUT /api/members/:id/plan-enrollment nao aguarda Control iD e retorna resumo
    const today = env.store.get("SELECT date('now', 'localtime') AS today").today;
    const enrolled = await env.request(`/members/${created.body.id}/plan-enrollment`, {
      method: 'PUT',
      body: JSON.stringify({ plan_id: mensal.id, starts_on: today }),
    });
    assert.equal(enrolled.status, 200);
    assert.equal(enrolled.body.member.access_status, 'active');
    assert.ok(enrolled.body.member.next_charge?.id);
    assert.ok(enrolled.elapsedMs < 300, `PUT /plan-enrollment demorou ${enrolled.elapsedMs}ms`);

    // 3. POST /api/payments com caixa fechado retorna 409 imediatamente
    const closedPay = await env.request('/payments', {
      method: 'POST',
      body: JSON.stringify({ member_id: created.body.id, plan_id: mensal.id, method: 'pix' }),
    });
    assert.equal(closedPay.status, 409);
    assert.equal(closedPay.body?.code, 'CASH_CLOSED');

    // Abrir caixa e registrar pagamento
    const openedCash = await env.request('/cash/open', {
      method: 'POST',
      body: JSON.stringify({ opening_cents: 10000 }),
    });
    assert.equal(openedCash.status, 201);
    const paid = await env.request('/payments', {
      method: 'POST',
      body: JSON.stringify({
        member_id: created.body.id,
        plan_id: mensal.id,
        charge_id: enrolled.body.member.next_charge.id,
        amount_cents: mensal.price_cents,
        method: 'pix',
      }),
    });
    assert.equal(paid.status, 201);
    assert.equal(paid.body.member.access_status, 'active');
    assert.equal(paid.body.member.next_charge, null);
    assert.ok(paid.elapsedMs < 300, `POST /payments demorou ${paid.elapsedMs}ms`);

    // 4. PUT /api/members/:id nao aguarda Control iD e dispara sync com forceIdentityUpdate
    const syncCountBeforeUpdate = env.syncCalls.length;
    const updated = await env.request(`/members/${created.body.id}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Aluno Rapido Atualizado',
        document: '52998224725',
      }),
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.member.name, 'Aluno Rapido Atualizado');
    assert.ok(updated.elapsedMs < 300, `PUT /members/:id demorou ${updated.elapsedMs}ms`);

    // 5. POST /api/members/:id/status nao aguarda Control iD
    const blocked = await env.request(`/members/${created.body.id}/status`, {
      method: 'POST',
      body: JSON.stringify({ status: 'blocked' }),
    });
    assert.equal(blocked.status, 200);
    assert.equal(blocked.body.member.status, 'blocked');
    assert.ok(blocked.elapsedMs < 300, `POST /status demorou ${blocked.elapsedMs}ms`);

    // Aguardar syncs em background finalizarem
    await new Promise((r) => setTimeout(r, 480));
    assert.ok(env.syncCalls.length > syncCountBeforeUpdate);
    const identityCall = env.syncCalls.find((c) => c.id === created.body.id && c.options?.forceIdentityUpdate === true);
    assert.ok(identityCall, 'PUT /members/:id deve agendar sync com forceIdentityUpdate: true');

    // 6. Cadastro sem pagamentos pode ser excluido sem aguardar deleteUser no Control iD
    const temp = await env.request('/members', {
      method: 'POST',
      body: JSON.stringify({ name: 'Aluno Temporario', document: '11144477735' }),
    });
    assert.equal(temp.status, 201);
    const deleted = await env.request(`/members/${temp.body.id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.ok, true);
    assert.ok(deleted.elapsedMs < 300, `DELETE /members/:id demorou ${deleted.elapsedMs}ms`);

    // Tentativa de excluir aluno com pagamento falha sincronamente
    const cannotDelete = await env.request(`/members/${created.body.id}`, { method: 'DELETE' });
    assert.ok(cannotDelete.status >= 400);

    await new Promise((r) => setTimeout(r, 480));
    assert.ok(env.deleteCalls.includes(temp.body.id));

    // 7. DELETE /api/payments/:id nao aguarda Control iD e retorna member resumo
    const delPay = await env.request(`/payments/${paid.body.payment.id}`, { method: 'DELETE' });
    assert.equal(delPay.status, 200);
    assert.equal(delPay.body.ok, true);
    assert.ok(delPay.body.member);
    assert.ok(delPay.elapsedMs < 300, `DELETE /payments/:id demorou ${delPay.elapsedMs}ms`);
  } finally {
    await env.close();
  }
});

test('POST /api/payments/batch processa multiplos alunos sem somar latencia do Control iD', async () => {
  const env = await createSlowControlIdTestServer({ syncDelayMs: 400 });
  try {
    const mensal = env.accessService.listPlans().find((p) => p.duration_days > 1 && p.price_cents > 0);
    const openedCash = await env.request('/cash/open', {
      method: 'POST',
      body: JSON.stringify({ opening_cents: 0 }),
    });
    assert.equal(openedCash.status, 201);
    const m1 = await env.accessService.createMember({ name: 'Lote Um', document: '52998224725', plan_id: mensal.id }, { backgroundSync: true });
    const m2 = await env.accessService.createMember({ name: 'Lote Dois', document: '11144477735', plan_id: mensal.id }, { backgroundSync: true });

    const batch = await env.request('/payments/batch', {
      method: 'POST',
      body: JSON.stringify({
        method: 'pix',
        items: [
          { member_id: m1.id, plan_id: mensal.id, amount_cents: mensal.price_cents },
          { member_id: m2.id, plan_id: mensal.id, amount_cents: mensal.price_cents },
        ],
      }),
    });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.count, 2);
    assert.ok(batch.elapsedMs < 350, `POST /payments/batch demorou ${batch.elapsedMs}ms`);

    await new Promise((r) => setTimeout(r, 480));
    assert.ok(env.syncCalls.some((c) => c.id === m1.id && c.allowed === true));
    assert.ok(env.syncCalls.some((c) => c.id === m2.id && c.allowed === true));
  } finally {
    await env.close();
  }
});

test('PUT /api/members/:id permite editar dados pessoais sem CPF quando o aluno nao tem CPF cadastrado', async () => {
  const env = await createSlowControlIdTestServer({ syncDelayMs: 0 });
  try {
    const legacyId = env.store.run(
      "INSERT INTO members (name, document, phone, status, access_role) VALUES ('Aluno Sem CPF', NULL, '62990001111', 'active', 'student')",
    ).lastInsertRowid;

    const updated = await env.request(`/members/${legacyId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: 'Aluno Sem CPF Atualizado',
        document: '',
        phone: '62998887777',
      }),
    });
    assert.equal(updated.status, 200);
    const saved = env.store.get('SELECT name, phone, document FROM members WHERE id = ?', [legacyId]);
    assert.equal(saved.name, 'Aluno Sem CPF Atualizado');
    assert.equal(saved.phone, '62998887777');
    assert.equal(saved.document, null);
  } finally {
    await env.close();
  }
});
