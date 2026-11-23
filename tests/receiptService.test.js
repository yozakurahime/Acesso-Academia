import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ControlIdClient } from '../src/services/controlIdClient.js';
import { AccessService } from '../src/services/accessService.js';
import { GymService } from '../src/services/gymService.js';
import { ReceiptService } from '../src/services/receiptService.js';

function makeMockGeminiFetch(payload) {
  return async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        candidates: [
          {
            content: {
              parts: [{ text: JSON.stringify(payload) }],
            },
          },
        ],
      };
    },
  });
}

test('ReceiptService analisa comprovante via Gemini, identifica aluno por telefone, bloqueia duplicidade e dá baixa', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId);
  const gymService = new GymService(store);
  const staff = gymService.createStaff({ name: 'Caixa 1' });
  gymService.openCashSession({ staff_id: staff.id, opening_cents: 1000 });

  const plan = accessService.listPlans().find((p) => p.price_cents === 12000);
  const member = await accessService.createMember({
    name: 'Carlos Pix',
    document: '52998224725',
    phone: '11988887777',
    plan_id: plan.id,
  });

  store.updateSettings({
    gemini_api_key: 'fake-key',
    pix_recipient_name: 'Academia Oxigenio',
    whatsapp_receipt_auto_approve: '0',
  });

  const receiptService = new ReceiptService(store, accessService, {
    fetchFn: makeMockGeminiFetch({
      is_receipt: true,
      amount_reais: 120.0,
      paid_date: '2026-11-14',
      payer_name: 'Carlos Pix',
      recipient_name: 'Academia Oxigenio LTDA',
      transaction_id: 'E1234567890',
      confidence: 95,
      summary: 'Pix R$ 120,00 para Academia Oxigenio',
    }),
  });

  const pending = await receiptService.processReceipt({
    base64Data: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    senderPhone: '5511988887777',
    source: 'whatsapp',
  });
  assert.equal(pending.status, 'pending');
  assert.equal(pending.member_id, member.id);
  assert.equal(pending.amount_cents, 12000);

  const approved = await receiptService.approveReceipt(pending.id, { method: 'pix' });
  assert.equal(approved.receipt.status, 'approved');
  assert.equal(approved.paymentResult.member.status, 'active');

  // Reenvio do mesmo comprovante (mesmo transaction_id) deve ser marcado como duplicado
  const dup = await receiptService.processReceipt({
    base64Data: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    senderPhone: '5511988887777',
    source: 'whatsapp',
  });
  assert.equal(dup.status, 'duplicate');
  await assert.rejects(() => receiptService.approveReceipt(dup.id), /duplicado/i);
});

test('ReceiptService deixa comprovante pendente até a conferência humana', async () => {
  const store = await DatabaseStore.create(null);
  store.updateSettings({ controlid_mock_mode: 'true' });
  const controlId = new ControlIdClient(() => store.getSettings());
  const accessService = new AccessService(store, controlId);
  const gymService = new GymService(store);
  const staff = gymService.createStaff({ name: 'Caixa 1' });
  gymService.openCashSession({ staff_id: staff.id, opening_cents: 0 });

  const plan = accessService.listPlans().find((p) => p.price_cents === 12000);
  const member = await accessService.createMember({
    name: 'Ana Auto',
    document: '11144477735',
    phone: '11977776666',
    plan_id: plan.id,
  });

  store.updateSettings({
    gemini_api_key: 'fake-key',
    pix_recipient_name: 'Academia Oxigenio',
    whatsapp_receipt_auto_approve: '1',
    pix_recipient_key: 'financeiro@example.test',
  });

  const validService = new ReceiptService(store, accessService, {
    fetchFn: makeMockGeminiFetch({
      is_receipt: true,
      amount_reais: 120.0,
      paid_date: '2026-11-14',
      payer_name: 'Ana Auto',
      recipient_name: 'Academia Oxigenio',
      transaction_id: 'E999999',
      recipient_key: 'financeiro@example.test',
      confidence: 96,
      summary: 'Pix OK',
    }),
  });

  const autoRes = await validService.processReceipt({
    base64Data: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    senderPhone: '5511977776666',
    source: 'whatsapp',
  });
  assert.equal(autoRes.status, 'pending');
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'pending');
  await validService.approveReceipt(autoRes.id);
  assert.equal(store.get('SELECT status FROM members WHERE id = ?', [member.id]).status, 'active');

  // Destinatário errado não deve dar baixa automática
  const wrongDestService = new ReceiptService(store, accessService, {
    fetchFn: makeMockGeminiFetch({
      is_receipt: true,
      amount_reais: 120.0,
      paid_date: '2026-11-14',
      payer_name: 'Ana Auto',
      recipient_name: 'Loja Qualquer',
      transaction_id: 'E888888',
      confidence: 96,
      summary: 'Pix outra conta',
    }),
  });
  const flagged = await wrongDestService.processReceipt({
    base64Data: 'aGVsbG8=',
    mimeType: 'image/jpeg',
    senderPhone: '5511977776666',
    source: 'whatsapp',
  });
  assert.equal(flagged.status, 'pending');
  assert.match(flagged.reject_reason, /Destinatário diferente/);
});
