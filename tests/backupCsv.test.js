import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
import { AccessService } from '../src/services/accessService.js';
import { BackupService } from '../src/services/backupService.js';

test('BackupService gera CSVs de alunos (padrao SCA), planos, cobrancas e recebimentos', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-backup-'));
  try {
    const store = await DatabaseStore.create(null);
    const access = new AccessService(store);
    const plan = access.createPlan({ name: 'Mensal', duration_days: 30, price_cents: 10000 });
    const member = await access.createMember({
      name: 'João de Barro',
      document: '52998224725',
      phone: '62999994444',
      plan_id: plan.id,
    });
    await access.recordPayment({ member_id: member.id, plan_id: plan.id, amount_cents: 10000, method: 'pix' });

    const backupSvc = new BackupService(store, dir);
    const info = backupSvc.createBackup();

    assert.ok(fs.existsSync(info.path));
    assert.ok(fs.existsSync(`${info.path}.csv/alunos.csv`));
    assert.ok(fs.existsSync(`${info.path}.csv/planos_vencimentos.csv`));
    assert.ok(fs.existsSync(`${info.path}.csv/cobrancas.csv`));
    assert.ok(fs.existsSync(`${info.path}.csv/recebimentos.csv`));

    const alunosCsv = fs.readFileSync(`${info.path}.csv/alunos.csv`, 'utf8');
    assert.ok(alunosCsv.includes('Codigo,Nome,Documento,Identidade,Email,Nascimento,Sexo,Telefone1,Telefone2,Endereco'));
    assert.ok(alunosCsv.includes('João de Barro'));

    const recCsv = fs.readFileSync(`${info.path}.csv/recebimentos.csv`, 'utf8');
    assert.ok(recCsv.includes('100.00'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('BackupService neutraliza formula injection (=, +, -, @) ao exportar CSV', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-backup-formula-'));
  try {
    const store = await DatabaseStore.create(null);
    store.updateSettings({ controlid_mock_mode: 'true' });
    const access = new AccessService(store);
    const plan = access.createPlan({ name: '+Plano', duration_days: 30, price_cents: 10000 });
    await access.createMember({
      name: '=CMD("calc")',
      document: '52998224725',
      email: '@evil.com',
      notes: '-1+1',
      plan_id: plan.id,
    });

    const backupSvc = new BackupService(store, dir);
    const info = backupSvc.createBackup();
    const alunosCsv = fs.readFileSync(`${info.path}.csv/alunos.csv`, 'utf8');
    assert.ok(alunosCsv.includes(`"'=CMD(""calc"")"`));
    assert.ok(alunosCsv.includes("'@evil.com"));
    assert.ok(alunosCsv.includes("'-1+1"));

    const planosCsv = fs.readFileSync(`${info.path}.csv/planos_vencimentos.csv`, 'utf8');
    assert.ok(planosCsv.includes("'+Plano"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
