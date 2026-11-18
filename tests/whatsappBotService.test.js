import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { GatewayService } from '../src/services/gatewayService.js';
import { CONTEXT_MISSING_HANDOFF_MARKER, WhatsappBotService } from '../src/services/whatsappBotService.js';

test('WhatsappBotService responde duvidas com contexto, mantem historico e identifica aluno', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    gemini_model: 'gemini-2.5-flash',
    whatsapp_bot_context: 'Horário da Academia Oxigênio: Segunda a Sexta das 06h às 22h.',
  });
  store.run(
    "INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal', 30, 12000)",
  );
  store.run(
    "INSERT INTO members (name, phone, status, valid_until, plan_id) VALUES ('Ana Paula', '64999998888', 'active', '2026-12-01', 1)",
  );

  const calls = [];
  const fakeFetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return {
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: 'Olá, Ana! Funcionamos de segunda a sexta, das 06h às 22h.' }] } }],
      }),
    };
  };

  const bot = new WhatsappBotService(store, { fetchFn: fakeFetch });
  const res = await bot.handleIncomingMessage({ phone: '5564999998888', text: 'Qual o horário hoje?' });

  assert.equal(res.requiresHuman, false);
  assert.match(res.reply, /Ana/);
  assert.equal(calls.length, 1);

  const systemText = calls[0].body.contents[0].parts[0].text;
  assert.match(systemText, /Horário da Academia Oxigênio/);
  assert.match(systemText, /Ana Paula/);

  // Segunda mensagem deve incluir o historico anterior
  await bot.handleIncomingMessage({ phone: '5564999998888', text: 'E sábado?' });
  assert.equal(calls.length, 2);
  const secondContents = calls[1].body.contents;
  assert.ok(secondContents.some((c) => c.parts?.[0]?.text === 'Qual o horário hoje?'));

});

test('WhatsappBotService pausa contato ao pedir atendente humano ou quando falta contexto', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
  });

  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      candidates: [{ content: { parts: [{ text: CONTEXT_MISSING_HANDOFF_MARKER }] } }],
    }),
  });

  const bot = new WhatsappBotService(store, { fetchFn: fakeFetch });

  const humanReq = await bot.handleIncomingMessage({
    phone: '5564999991111',
    text: 'Quero falar com um atendente humano por favor',
  });
  assert.equal(humanReq.requiresHuman, true);
  assert.equal(humanReq.reason, 'human_request');
  assert.equal(bot.isPaused('5564999991111'), true);

  // Enquanto pausado, nao responde automaticamente
  const ignored = await bot.handleIncomingMessage({ phone: '5564999991111', text: 'Oi?' });
  assert.equal(ignored, null);

  // Outro contato dispara context_missing vindo do modelo
  const missing = await bot.handleIncomingMessage({ phone: '5564999992222', text: 'Qual o telefone do nutricionista?' });
  assert.equal(missing.requiresHuman, true);
  assert.equal(missing.reason, 'context_missing');
  assert.equal(bot.isPaused('5564999992222'), true);

  // Takeover manual do dono pausa e resumeContact libera
  bot.markHumanTakeover('5564999993333');
  assert.equal(bot.isPaused('5564999993333'), true);
  bot.resumeContact('5564999993333');
  assert.equal(bot.isPaused('5564999993333'), false);

});

test('WhatsappBotService fica inativo quando whatsapp_bot_enabled != 1', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ whatsapp_bot_enabled: '0', gemini_api_key: 'fake-key' });
  const bot = new WhatsappBotService(store);
  const res = await bot.handleIncomingMessage({ phone: '5564999994444', text: 'Oi' });
  assert.equal(res, null);
});

test('WhatsappBotService guia pagamento Mercado Pago para 1 ou mais pessoas em lote e da baixa em todas', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({
    whatsapp_bot_enabled: '1',
    gemini_api_key: 'fake-key',
    mp_access_token: 'TEST-MP-TOKEN',
  });
  const p1 = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Mensal Teste', 30, 12000)").lastInsertRowid;
  const p2 = store.run("INSERT INTO plans (name, duration_days, price_cents) VALUES ('Kids Teste', 30, 9000)").lastInsertRowid;
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Carlos Pai', '11122233344', '5562999991111', 'blocked', '2026-10-01', ?)",
    [p1],
  );
  store.run(
    "INSERT INTO members (name, document, phone, status, valid_until, plan_id) VALUES ('Lucas Filho', '55566677788', '5562988882222', 'blocked', '2026-10-01', ?)",
    [p2],
  );
  store.run("INSERT INTO cash_sessions (status, opening_cents, opened_at) VALUES ('open', 0, datetime('now', 'localtime'))");

  const accessService = new AccessService(store, null, null);
  const mpCalls = [];
  const fakeMpFetch = async (url, init = {}) => {
    mpCalls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    if (String(url).includes('/v1/payments') && (init.method || 'GET') === 'POST') {
      const payload = {
        id: 99887766,
        status: 'pending',
        point_of_interaction: {
          transaction_data: {
            qr_code: '000201010212PIX_LOTE_210_REAIS',
            qr_code_base64: 'ZmFrZQ==',
            ticket_url: 'https://mercadopago.com.br/pix/99887766',
          },
        },
      };
      return { ok: true, status: 201, json: async () => payload, text: async () => JSON.stringify(payload) };
    }
    const payload = { id: 99887766, status: 'approved', transaction_amount: 210 };
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) };
  };

  const gatewayService = new GatewayService(store, accessService, { fetchFn: fakeMpFetch });
  const bot = new WhatsappBotService(store, { gatewayService });

  const step1 = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Quero pagar minha mensalidade' });
  assert.match(step1.reply, /Carlos Pai/);
  assert.match(step1.reply, /120,00/);

  const step2 = await bot.handleIncomingMessage({ phone: '5562999991111', text: '55566677788' });
  assert.match(step2.reply, /Lucas Filho/);
  assert.match(step2.reply, /210,00/);

  const discountAttempt = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Tenho desconto, posso pagar menos?' });
  assert.match(discountAttempt.reply, /não aplicamos descontos/i);
  assert.match(discountAttempt.reply, /210,00/);

  const step3 = await bot.handleIncomingMessage({ phone: '5562999991111', text: '1' });
  assert.match(step3.reply, /000201010212PIX_LOTE_210_REAIS/);
  assert.equal(mpCalls[0].body.transaction_amount, 210);

  const step4 = await bot.handleIncomingMessage({ phone: '5562999991111', text: 'Já paguei' });
  assert.match(step4.reply, /Pagamento confirmado/);

  const payments = store.all('SELECT member_id, amount_cents, method FROM payments ORDER BY member_id');
  assert.equal(payments.length, 2);
  assert.deepEqual(payments.map((p) => [p.member_id, p.amount_cents, p.method]), [
    [1, 12000, 'pix'],
    [2, 9000, 'pix'],
  ]);
  const m1 = store.get('SELECT status FROM members WHERE id = 1');
  const m2 = store.get('SELECT status FROM members WHERE id = 2');
  assert.equal(m1.status, 'active');
  assert.equal(m2.status, 'active');
});
