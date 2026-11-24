import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { EdgeSyncClient } from '../src/services/edgeSyncService.js';
import { WhatsappService } from '../src/services/whatsappService.js';

test('DatabaseStore suporta transacoes aninhadas via SAVEPOINT e preserva erro original', async () => {
  const store = await DatabaseStore.create();

  store.transaction(() => {
    store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Plano Outer', 30, 10000)");
    assert.throws(() => {
      store.transaction(() => {
        store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Plano Inner Rollback', 30, 9999)");
        throw new Error('falha interna');
      });
    }, /falha interna/);

    store.transaction(() => {
      store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Plano Inner Commit', 30, 12000)");
    });
  });

  const names = store.all('SELECT name FROM plans').map((r) => r.name);
  assert.ok(names.includes('Plano Outer'));
  assert.ok(names.includes('Plano Inner Commit'));
  assert.ok(!names.includes('Plano Inner Rollback'));
});

test('DatabaseStore.all libera statement quando bind/step falha e permite consultas subsequentes', async () => {
  const store = await DatabaseStore.create();
  assert.throws(() => {
    store.all('SELECT * FROM plans WHERE id = ?', [{ invalid: true }]);
  });
  const rows = store.all('SELECT COUNT(*) AS c FROM plans');
  assert.equal(typeof rows[0].c, 'number');
});

test('DatabaseStore.transaction preserva erro de save quando arquivo ainda nao existe em disco', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-rel-'));
  const filePath = path.join(dir, 'nested', 'acesso.sqlite');
  try {
    const store = await DatabaseStore.create();
    store.filePath = filePath;
    store.save = () => {
      throw new Error('disco cheio simulado');
    };
    assert.throws(() => {
      store.transaction(() => {
        store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Teste', 30, 5000)");
      });
    }, /disco cheio simulado/);
    assert.equal(store.inTransaction, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AccessService.trySyncMemberToDevice nao bloqueia resposta aguardando leitores secundarios', async () => {
  const { AccessService } = await import('../src/services/accessService.js');
  const store = await DatabaseStore.create();
  const plan = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 10000)").lastInsertRowid;
  const memberId = store.run(
    "INSERT INTO members (name, plan_id, valid_until, status, access_role) VALUES ('Aluno Teste', ?, '2099-01-01', 'active', 'student')",
    [plan],
  ).lastInsertRowid;

  const primaryControlId = {
    syncMember: async () => ({ controlIdUserId: memberId, allowed: true, mock: true }),
  };
  const access = new AccessService(store, primaryControlId);
  let secondaryFinished = false;
  access._getSecondaryControlIdClients = () => [
    {
      client: {
        syncMember: () => new Promise((resolve) => setTimeout(() => { secondaryFinished = true; resolve({ synced: true }); }, 150)),
      },
    },
  ];

  const member = access.getMember(memberId);
  const t0 = performance.now();
  const sync = await access.trySyncMemberToDevice(member);
  const elapsed = performance.now() - t0;

  assert.equal(sync.synced, true);
  assert.ok(elapsed < 80, `trySyncMemberToDevice demorou ${elapsed}ms esperando leitor secundario`);
  assert.equal(secondaryFinished, false);
  await new Promise((r) => setTimeout(r, 180));
  assert.equal(secondaryFinished, true);
});

test('EdgeSyncClient.start e idempotente (nao vaza timers) e registra erro de comando SSE', async () => {
  const store = await DatabaseStore.create();
  const encoder = new TextEncoder();
  let streamCalls = 0;
  const fetchFn = async (url) => {
    if (url.includes('/api/edge/commands')) {
      streamCalls += 1;
      if (streamCalls === 1) {
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('data: {"id":"1","type":"release"}\n\n'));
            controller.close();
          },
        });
        return new Response(stream, { status: 200 });
      }
      return new Response('', { status: 503 });
    }
    if (url.includes('/api/edge/snapshot')) {
      return new Response(JSON.stringify({ plans: [], members: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };

  const client = new EdgeSyncClient({
    store,
    accessService: {
      releaseTurnstile: async () => {
        throw new Error('catraca offline');
      },
    },
    cloudUrl: 'https://cloud.example.com',
    token: 'tok',
    fetchFn,
    syncIntervalMs: 60000,
    reconnectDelayMs: 60000,
  });

  client.start();
  const firstTimer = client._syncTimer;
  client.start();
  assert.notEqual(client._syncTimer, firstTimer);
  await new Promise((r) => setTimeout(r, 40));
  client.stop();
  assert.equal(client._syncTimer, null);
  assert.equal(client._reconnectTimer, null);
});

test('WhatsappService.connect reseta status para disconnected se authDir falhar', async () => {
  const store = await DatabaseStore.create();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-fail-'));
  const fileBlockingDir = path.join(dir, 'not-a-dir');
  fs.writeFileSync(fileBlockingDir, 'bloqueio');

  try {
    const wa = new WhatsappService(store, { authDir: fileBlockingDir });
    await assert.rejects(() => wa.connect());
    assert.equal(wa.status, 'disconnected');
    assert.ok(wa.lastError);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('DatabaseStore.runDeferred aplica escrita em memoria imediatamente e agenda save em background', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-deferred-'));
  const filePath = path.join(dir, 'acesso.sqlite');
  try {
    const store = await DatabaseStore.create(filePath);
    let asyncSaveCalls = 0;
    const origSaveAsync = store.saveAsync.bind(store);
    store.saveAsync = () => {
      asyncSaveCalls += 1;
      return origSaveAsync();
    };

    const res = store.runDeferred(
      "INSERT INTO audit_logs (actor_user, actor_role, action, entity) VALUES ('adm', 'admin', 'test.deferred', 'test')",
      [],
      20,
    );
    assert.equal(res.changes, 1);
    assert.equal(asyncSaveCalls, 0);
    assert.ok(store._saveTimer);
    const row = store.get("SELECT action FROM audit_logs WHERE action = 'test.deferred'");
    assert.equal(row?.action, 'test.deferred');

    const deadline = Date.now() + 500;
    while (asyncSaveCalls === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    await store._asyncSaveQueue;
    assert.equal(asyncSaveCalls, 1);
    assert.ok(fs.existsSync(filePath));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('savePlanEnrollment e recordPayment retornam member resumo com access_status, in_grace e next_charge', async () => {
  const store = await DatabaseStore.create();
  const access = new AccessService(store);
  const plan = access.listPlans().find((p) => p.duration_days > 1 && p.price_cents > 0);
  assert.ok(plan);
  const member = await access.createMember({ name: 'Aluno Resumo', document: '52998224725' });
  const initialSummary = access.getMemberSummary(member.id);
  assert.equal(initialSummary.access_status, 'pending');
  assert.equal(initialSummary.in_grace, 0);

  const today = store.get("SELECT date('now', 'localtime') AS today").today;
  const enrolled = await access.savePlanEnrollment(member.id, { plan_id: plan.id, starts_on: today });
  assert.equal(enrolled.member.access_status, 'active');
  assert.equal(enrolled.member.plan_id, plan.id);
  assert.ok(enrolled.member.valid_until >= today);
  assert.ok(enrolled.member.next_charge);

  const paid = await access.recordPayment({
    member_id: member.id,
    plan_id: plan.id,
    charge_id: enrolled.member.next_charge.id,
    amount_cents: plan.price_cents,
    method: 'pix',
  }, { requireOpenCash: false });
  assert.equal(paid.member.access_status, 'active');
  assert.equal(paid.member.in_grace, 0);
  assert.equal(paid.member.next_charge, null);
});

test('DatabaseStore.flush limpa timer pendente e persiste imediatamente, e saveAsync persiste sem bloquear', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-flush-async-'));
  const filePath = path.join(dir, 'acesso.sqlite');
  try {
    const store = await DatabaseStore.create(filePath);
    store.runDeferred(
      "INSERT INTO audit_logs (actor_user, actor_role, action, entity) VALUES ('adm', 'admin', 'test.flush', 'test')",
      [],
      5000,
    );
    assert.ok(store._saveTimer);
    assert.equal(store.flush(), true);
    assert.equal(store._saveTimer, null);
    assert.equal(store.flush(), false);

    const reopened1 = await DatabaseStore.create(filePath);
    assert.equal(reopened1.get("SELECT action FROM audit_logs WHERE action = 'test.flush'")?.action, 'test.flush');

    store.runDeferred(
      "INSERT INTO audit_logs (actor_user, actor_role, action, entity) VALUES ('adm', 'admin', 'test.async', 'test')",
      [],
      5000,
    );
    await store.saveAsync();
    assert.equal(store._saveTimer, null);

    const reopened2 = await DatabaseStore.create(filePath);
    assert.equal(reopened2.get("SELECT action FROM audit_logs WHERE action = 'test.async'")?.action, 'test.async');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
