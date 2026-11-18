import fs from 'node:fs';
import path from 'node:path';

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const s = String(val);
  if (/[",\r\n]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function toCsv(headers, rows) {
  const lines = [headers.map(csvEscape).join(',')];
  for (const row of rows) {
    lines.push(row.map(csvEscape).join(','));
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

function formatSexo(sex) {
  const s = String(sex || '').trim().toLowerCase();
  if (s === 'masculino' || s === 'm') return 'M';
  if (s === 'feminino' || s === 'f') return 'F';
  return '';
}

export class BackupService {
  constructor(store, backupDir) {
    this.store = store;
    this.backupDir = path.resolve(backupDir);
  }

  buildCsvExport(kind) {
    const cleanKind = String(kind || '').trim().toLowerCase();
    if (cleanKind === 'alunos') {
      const headers = [
        'Codigo', 'Nome', 'Documento', 'Identidade', 'Email', 'Nascimento', 'Sexo',
        'Telefone1', 'Telefone2', 'Endereco', 'Numero', 'Complemento', 'Bairro',
        'Cidade', 'Estado', 'Cep', 'Pai', 'Mae', 'EstadoCivil', 'Pessoa', 'Fantasia',
        'Observacao', 'Cracha', 'Cadastro', 'Credito',
      ];
      const members = this.store.all(
        `SELECT id, name, document, email, birth_date, sex, phone, address, notes,
                controlid_user_id, created_at, credit_cents
         FROM members ORDER BY id ASC`,
      );
      const rows = members.map((m) => [
        m.id,
        m.name,
        m.document || '',
        '',
        m.email || '',
        m.birth_date || '',
        formatSexo(m.sex),
        m.phone || '',
        '',
        m.address || '',
        '', '', '', '', '', '', '', '', '',
        'Física',
        '',
        m.notes || '',
        m.controlid_user_id || '',
        m.created_at || '',
        Number(m.credit_cents || 0) > 0 ? (Number(m.credit_cents) / 100).toFixed(2) : '',
      ]);
      return { filename: 'alunos.csv', content: toCsv(headers, rows) };
    }

    if (cleanKind === 'planos') {
      const headers = [
        'CodigoAluno', 'Nome', 'Documento', 'Telefone', 'Modalidade', 'Plano',
        'DuracaoDias', 'ValorPlano', 'Status', 'Inicio', 'Vencimento',
      ];
      const rowsData = this.store.all(
        `SELECT m.id, m.name, m.document, m.phone, m.status, m.valid_until,
                mo.name AS modality_name, p.name AS plan_name, p.duration_days, p.price_cents,
                pe.starts_on, pe.ends_on
         FROM members m
         LEFT JOIN modalities mo ON mo.id = m.modality_id
         LEFT JOIN plan_enrollments pe ON pe.member_id = m.id
         LEFT JOIN plans p ON p.id = COALESCE(pe.plan_id, m.plan_id)
         WHERE m.access_role = 'student'
         ORDER BY m.id ASC`,
      );
      const rows = rowsData.map((r) => [
        r.id,
        r.name,
        r.document || '',
        r.phone || '',
        r.modality_name || '',
        r.plan_name || '',
        r.duration_days || '',
        r.price_cents != null ? (Number(r.price_cents) / 100).toFixed(2) : '',
        r.status || '',
        r.starts_on || '',
        r.ends_on || r.valid_until || '',
      ]);
      return { filename: 'planos_vencimentos.csv', content: toCsv(headers, rows) };
    }

    if (cleanKind === 'cobrancas') {
      const headers = [
        'CodigoCobranca', 'CodigoAluno', 'Nome', 'Documento', 'Vencimento',
        'Valor', 'Situacao', 'Origem', 'IdPagamento',
      ];
      const rowsData = this.store.all(
        `SELECT c.id, c.member_id, m.name, m.document, c.due, c.amount, c.source, c.payment_id
         FROM membership_charges c
         JOIN members m ON m.id = c.member_id
         ORDER BY c.due DESC, c.id DESC`,
      );
      const rows = rowsData.map((r) => [
        r.id,
        r.member_id,
        r.name,
        r.document || '',
        r.due || '',
        (Number(r.amount || 0) / 100).toFixed(2),
        r.payment_id ? 'Pago' : 'Em aberto',
        r.source || 'auto',
        r.payment_id || '',
      ]);
      return { filename: 'cobrancas.csv', content: toCsv(headers, rows) };
    }

    if (cleanKind === 'recebimentos') {
      const headers = [
        'CodigoPagamento', 'CodigoAluno', 'Nome', 'Documento', 'Plano',
        'ValorPago', 'FormaPagamento', 'DataPagamento', 'Observacao',
      ];
      const rowsData = this.store.all(
        `SELECT pay.id, pay.member_id, m.name, m.document, p.name AS plan_name,
                pay.amount_cents, pay.method, pay.paid_at, pay.notes
         FROM payments pay
         JOIN members m ON m.id = pay.member_id
         LEFT JOIN plans p ON p.id = pay.plan_id
         ORDER BY pay.paid_at DESC, pay.id DESC`,
      );
      const rows = rowsData.map((r) => [
        r.id,
        r.member_id,
        r.name,
        r.document || '',
        r.plan_name || '',
        (Number(r.amount_cents || 0) / 100).toFixed(2),
        r.method || '',
        r.paid_at || '',
        r.notes || '',
      ]);
      return { filename: 'recebimentos.csv', content: toCsv(headers, rows) };
    }

    throw httpError('Tipo de exportação CSV inválido.', 400);
  }

  createBackup({ maxKeep = 30 } = {}) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const filename = `oxigenio-${stamp}.sqlite`;
    const targetPath = path.join(this.backupDir, filename);

    const data = this.store.db.export();
    fs.writeFileSync(targetPath, Buffer.from(data), { flush: true });

    const csvDir = `${targetPath}.csv`;
    fs.mkdirSync(csvDir, { recursive: true });
    for (const kind of ['alunos', 'planos', 'cobrancas', 'recebimentos']) {
      const exported = this.buildCsvExport(kind);
      fs.writeFileSync(path.join(csvDir, exported.filename), exported.content, 'utf8');
    }

    const dataRootDir = this.store.filePath
      ? path.dirname(path.resolve(this.store.filePath))
      : path.dirname(this.backupDir);
    const photosDir = path.join(dataRootDir, 'photos');
    let hasPhotosBackup = false;
    if (fs.existsSync(photosDir) && fs.statSync(photosDir).isDirectory()) {
      fs.cpSync(photosDir, `${targetPath}.photos`, { recursive: true, force: true });
      hasPhotosBackup = true;
    }

    const createdAt = now.toISOString();
    this.store.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_last_at', ?)`,
      [createdAt],
    );

    const keep = Math.max(1, Math.floor(Number(maxKeep) || 30));
    const allBackups = this.listBackups();
    for (const stale of allBackups.slice(keep)) {
      const stalePath = path.join(this.backupDir, stale.filename);
      fs.rmSync(stalePath, { force: true });
      fs.rmSync(`${stalePath}.photos`, { recursive: true, force: true });
      fs.rmSync(`${stalePath}.csv`, { recursive: true, force: true });
    }

    const stat = fs.statSync(targetPath);
    return {
      filename,
      path: targetPath,
      size: stat.size,
      size_bytes: stat.size,
      photos_included: hasPhotosBackup,
      created_at: createdAt,
    };
  }

  listBackups() {
    if (!fs.existsSync(this.backupDir)) {
      return [];
    }

    const entries = fs
      .readdirSync(this.backupDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'));

    const backups = entries.map((entry) => {
      const fullPath = path.join(this.backupDir, entry.name);
      const stat = fs.statSync(fullPath);
      return {
        filename: entry.name,
        size_bytes: stat.size,
        created_at: stat.mtime.toISOString(),
      };
    });

    backups.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.filename.localeCompare(a.filename));
    return backups;
  }

  getBackupPath(filename) {
    const raw = String(filename || '');
    if (
      !raw ||
      raw.includes('/') ||
      raw.includes('\\') ||
      raw.includes('..') ||
      path.basename(raw) !== raw ||
      !raw.endsWith('.sqlite')
    ) {
      throw httpError('Nome de arquivo de backup inválido.', 400);
    }

    const resolved = path.resolve(this.backupDir, raw);
    const expectedPrefix = `${this.backupDir}${path.sep}`;
    if (!resolved.startsWith(expectedPrefix)) {
      throw httpError('Nome de arquivo de backup inválido.', 400);
    }

    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      throw httpError('Backup não encontrado.', 404);
    }

    return resolved;
  }
}
