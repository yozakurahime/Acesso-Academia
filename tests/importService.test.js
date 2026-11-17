import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseStore } from '../src/db.js';
import { ImportService, decodeHtml, parseHtmlTables } from '../src/services/importService.js';

describe('ImportService (SCA & Control iD)', () => {
  let store;
  let service;

  beforeEach(async () => {
    store = await DatabaseStore.create(null);
    const mockControlId = {
      getConfig() {
        return { mockMode: false };
      },
      async requestJson(path, body) {
        assert.equal(path, '/load_objects.fcgi');
        assert.equal(body.object, 'users');
        return {
          users: [
            { id: 101, name: 'Maria Silva', registration: '111.222.333-44' },
            { id: 202, name: 'Visitante Novo', registration: '' },
          ],
        };
      },
    };
    service = new ImportService(store, mockControlId);
  });

  it('decodifica entidades HTML e extrai tabelas do SCA', () => {
    assert.equal(decodeHtml('Jo&#227;o &amp; Concei&#231;&#227;o&nbsp;'), 'João & Conceição');
    const tables = parseHtmlTables(
      '<table><caption>Exporta&#231;&#227;o de Alunos</caption><tr><th>Nome-Completo</th></tr><tr><td>Ana</td></tr></table>',
    );
    assert.equal(tables.length, 1);
    assert.deepEqual(tables[0], {
      caption: 'Exportação de Alunos',
      headers: ['Nome-Completo'],
      rows: [['Ana']],
    });
  });

  it('importa alunos do SCA ignorando linhas de erro/teste e evitando duplicidade', () => {
    const html = `
      <html><body>
        <table>
          <caption>Exporta&#231;&#227;o de Alunos</caption>
          <tr><th>Nome-Completo</th><th>CPF</th><th>Telefone-1</th><th>E-mail</th><th>Cidade</th><th>Estado</th></tr>
          <tr><td>Maria Silva</td><td>111.222.333-44</td><td>(11) 99999-0000</td><td>maria@teste.com</td><td>Any</td><td>SP</td></tr>
          <tr><td>Erro</td><td>- - -</td><td>- - -</td><td>- - -</td><td>- - -</td><td>- - -</td></tr>
        </table>
      </body></html>
    `;
    const r1 = service.importScaHtml(html);
    assert.equal(r1.membersImported, 1);
    assert.equal(r1.membersSkipped, 1);

    const members = store.all('SELECT * FROM members');
    assert.equal(members.length, 1);
    assert.equal(members[0].name, 'Maria Silva');
    assert.equal(members[0].document, '111.222.333-44');
    assert.equal(members[0].address, 'SP');
    assert.equal(members[0].status, 'pending');

    const r2 = service.importScaHtml(html);
    assert.equal(r2.membersImported, 0);
    assert.equal(r2.membersSkipped, 2);
  });

  it('importa usuarios (atendentes) e professores do SCA', () => {
    const usersHtml = `
      <table>
        <caption>Exporta&#231;&#227;o de Usu&#225;rios</caption>
        <tr><th>Nome-Completo</th><th>Telefone-1</th><th>Administrador</th></tr>
        <tr><td>Jo&#227;o Recep&#231;&#227;o</td><td>11988887777</td><td>N&#227;o</td></tr>
        <tr><td>Ana Gerente</td><td>11911112222</td><td>Sim</td></tr>
      </table>
    `;
    const rUsers = service.importScaHtml(usersHtml);
    assert.equal(rUsers.staffImported, 2);

    const profHtml = `
      <table>
        <caption>Exporta&#231;&#227;o de Professores</caption>
        <tr><th>Codigo-do-Professor</th><th>Nome-Completo</th><th>Telefone-1-ou-2</th></tr>
        <tr><td>20</td><td>Carlos Personal</td><td>11977776666</td></tr>
      </table>
    `;
    const rProf = service.importScaHtml(profHtml);
    assert.equal(rProf.instructorsImported, 1);
  });

  it('sincroniza usuarios existentes do Control iD vinculando alunos e criando faltantes', async () => {
    store.run("INSERT INTO members (name, document, status) VALUES (?, ?, 'active')", [
      'Maria Silva',
      '111.222.333-44',
    ]);

    const sync = await service.syncUsersFromControlId();
    assert.equal(sync.totalOnDevice, 2);
    assert.equal(sync.linked, 1);
    assert.equal(sync.imported, 1);

    const maria = store.get('SELECT * FROM members WHERE name = ?', ['Maria Silva']);
    assert.equal(maria.controlid_user_id, 101);
    assert.equal(maria.face_registered, 1);
  });

  it('importa matriculas e vencimentos do SCA criando planos e mantendo a data mais recente', () => {
    store.run("INSERT INTO members (name, status) VALUES (?, 'pending')", ['Maria Silva']);
    const today = new Date();
    const recentStart = new Date(today.getTime() - 5 * 86400000);
    const brRecent = `${String(recentStart.getDate()).padStart(2, '0')}/${String(recentStart.getMonth() + 1).padStart(2, '0')}/${recentStart.getFullYear()}`;

    const html = `
      <table>
        <caption>Exporta&#231;&#227;o de Matr&#237;culas</caption>
        <tr><th>Codigo</th><th>Nome-Completo</th><th>Plano</th><th>Periodicidade</th><th>Inicio</th><th>Fim</th><th>Valor</th><th>Valor-Cobranca</th></tr>
        <tr><td>1</td><td>Maria Silva</td><td>Hidrogin&#225;stica</td><td>Mensal</td><td>01/01/2020</td><td>&nbsp;</td><td>150,00</td><td>150,00</td></tr>
        <tr><td>1</td><td>Maria Silva</td><td>Hidrogin&#225;stica</td><td>Mensal</td><td>${brRecent}</td><td>&nbsp;</td><td>150,00</td><td>150,00</td></tr>
        <tr><td>2</td><td>Aluno Vencido</td><td>Muscula&#231;&#227;o</td><td>Mensal</td><td>01/01/2022</td><td>31/01/2022</td><td>100,00</td><td>100,00</td></tr>
        <tr><td>3</td><td>Exemplo</td><td>Personalizado</td><td>&nbsp;</td><td>27/12/2022</td><td>&nbsp;</td><td>0,00</td><td>0,00</td></tr>
      </table>
    `;

    const res = service.importScaHtml(html);
    assert.equal(res.plansCreated, 2);
    assert.equal(res.modalitiesCreated, 1); // Musculação já vem no seed, Hidroginástica é criada
    assert.equal(res.enrollmentsUpdated, 3);

    const maria = store.get('SELECT * FROM members WHERE name = ?', ['Maria Silva']);
    assert.equal(maria.status, 'active');
    assert.ok(maria.valid_until > '2025-01-01');
    assert.ok(maria.modality_id > 0);
    const mariaPlan = store.get('SELECT * FROM plans WHERE id = ?', [maria.plan_id]);
    assert.equal(mariaPlan.name, 'Hidroginástica (Mensal)');

    const vencido = store.get('SELECT * FROM members WHERE name = ?', ['Aluno Vencido']);
    assert.equal(vencido.status, 'blocked');
    assert.equal(vencido.valid_until, '2022-01-31');
  });

  it('importa turmas do SCA extraindo modalidade, horario, lotacao e professor', () => {
    store.run("INSERT INTO instructors (name) VALUES ('Gustavo Silva')");
    const html = `
      <table>
        <caption>Exporta&#231;&#227;o de Turmas</caption>
        <tr><th>Codigo-da-Turma</th><th>Turma</th><th>Lotacao</th><th>Situacao</th></tr>
        <tr><td>102702</td><td>Hidrogin&#225;stica Seg/Qua/Sex 08:00 - Gustavo</td><td>15</td><td>A</td></tr>
        <tr><td>102710</td><td>Nata&#231;&#227;o Baby Ter/Qui 16:00</td><td>5</td><td>A</td></tr>
      </table>
    `;
    const res = service.importScaHtml(html);
    assert.equal(res.classesImported, 2);

    const hidro = store.get("SELECT * FROM classes WHERE name LIKE 'Hidrogin%'");
    assert.equal(hidro.capacity, 15);
    assert.equal(hidro.schedule, 'Seg/Qua/Sex 08:00');
    assert.ok(hidro.instructor_id > 0);
    assert.ok(hidro.modality_id > 0);
  });

  it('importa cobranças sem renovar a matrícula e sincroniza lista exclusiva de ativos do SCA', () => {
    store.run("INSERT INTO members (name, valid_until, status) VALUES ('Maria Silva', '2023-05-10', 'blocked')");
    store.run("INSERT INTO members (name, valid_until, status) VALUES ('Joao Inativo', '2026-12-30', 'active')");

    const futureDate = new Date(Date.now() + 10 * 86400000);
    const futureBr = `${String(futureDate.getDate()).padStart(2, '0')}/${String(futureDate.getMonth() + 1).padStart(2, '0')}/${futureDate.getFullYear()}`;
    const futureIso = futureBr.split('/').reverse().join('-');

    const cobrancasHtml = `
      <table>
        <caption>Exporta&#231;&#227;o de Cobran&#231;as</caption>
        <tr><th>Codigo</th><th>Nome-ou-Razao-Social</th><th>Vencimento</th><th>Valor</th><th>Telefone-1-ou-2</th><th>Data-de-Inclusao</th></tr>
        <tr><td>1</td><td>Maria Silva</td><td>10/06/2023</td><td>100,00</td><td>&nbsp;</td><td>01/06/2023</td></tr>
        <tr><td>2</td><td>Maria Silva</td><td>${futureBr}</td><td>120,00</td><td>&nbsp;</td><td>01/11/2026</td></tr>
      </table>
    `;

    const preview = service.importScaHtml(cobrancasHtml, { preview: true });
    assert.equal(preview.chargesUpdated, 2);
    assert.equal(store.get('SELECT COUNT(*) AS total FROM membership_charges').total, 0);
    const cRes = service.importScaHtml(cobrancasHtml);
    assert.equal(cRes.chargesUpdated, 2);
    assert.equal(cRes.activatedMembers, 0);
    assert.equal(store.get('SELECT COUNT(*) AS total FROM membership_charges').total, 2);
    assert.equal(store.get('SELECT amount FROM membership_charges WHERE due = ?', [futureIso]).amount, 12000);
    assert.equal(service.importScaHtml(cobrancasHtml).chargesUpdated, 0);

    const maria = store.get("SELECT status, valid_until FROM members WHERE name = 'Maria Silva'");
    assert.equal(maria.status, 'blocked');
    assert.equal(maria.valid_until, '2023-05-10');

    const activeAlunosHtml = `
      <table>
        <caption>Exporta&#231;&#227;o de Alunos</caption>
        <tr><th>Nome-Completo</th><th>CPF</th></tr>
        <tr><td>Maria Silva</td><td>111.111.111-11</td></tr>
      </table>
    `;
    service.importScaHtml(activeAlunosHtml, { exclusiveActiveList: true });
    const joao = store.get("SELECT status FROM members WHERE name = 'Joao Inativo'");
    assert.equal(joao.status, 'blocked');
  });

  it('importa recebimentos do SCA registrando pagamentos e renovando validade e plan_enrollments', () => {
    const plan = store.get("SELECT id FROM plans WHERE name = 'Mensal'");
    store.run(
      "INSERT INTO members (name, document, plan_id, valid_until, status) VALUES ('Luciano Teste', '886.197.371-04', ?, '2026-11-10', 'blocked')",
      [plan.id],
    );
    const today = new Date();
    const paidBr = `${String(today.getDate()).padStart(2, '0')}/${String(today.getMonth() + 1).padStart(2, '0')}/${today.getFullYear()}`;
    const html = `
      <table>
        <caption>Exporta&#231;&#227;o de Recebimentos</caption>
        <tr><th>Codigo</th><th>Nome-ou-Razao-Social</th><th>CPF-ou-CNPJ</th><th>Vencimento</th><th>Valor</th><th>Pagamento</th><th>Valor-Pago</th></tr>
        <tr><td>50</td><td>Luciano Teste</td><td>886.197.371-04</td><td>${paidBr}</td><td>100,00</td><td>${paidBr}</td><td>100,00</td></tr>
        <tr><td>722</td><td>Cadastro Exclu&#237;do</td><td>&nbsp;</td><td>${paidBr}</td><td>120,00</td><td>${paidBr}</td><td>120,00</td></tr>
        <tr><td>353</td><td>Luciano Teste</td><td>886.197.371-04</td><td>${paidBr}</td><td>100,00</td><td>${paidBr}</td><td>0,00</td></tr>
      </table>
    `;
    const res = service.importScaHtml(html);
    assert.equal(res.receiptsImported, 1);
    assert.equal(res.enrollmentsUpdated, 1);
    assert.equal(res.activatedMembers, 1);

    const updated = store.get("SELECT status, valid_until FROM members WHERE name = 'Luciano Teste'");
    assert.equal(updated.status, 'active');
    assert.ok(updated.valid_until > new Date().toISOString().slice(0, 10));

    const enrollment = store.get('SELECT ends_on FROM plan_enrollments WHERE member_id = (SELECT id FROM members WHERE name = ?)', ['Luciano Teste']);
    assert.equal(enrollment.ends_on, updated.valid_until);
  });
});
