import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
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
