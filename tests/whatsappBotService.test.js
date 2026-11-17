import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
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
