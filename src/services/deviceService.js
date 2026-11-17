const TURNSTILE_DRIVERS = ['toletus', 'controlid'];
const DIRECTIONS = ['entry', 'exit', 'both'];
const FREE_SIDES = ['none', 'entry', 'exit', 'both'];
const ACTION_MODES = ['sec_box', 'door'];

function validateHost(value, label = 'IP') {
  const host = String(value || '').trim();
  if (!host || host.length > 253 || !/^[a-zA-Z0-9.-]+$/.test(host)) {
    const err = new Error(`${label} inválido.`);
    err.statusCode = 400;
    throw err;
  }
  return host;
}

function validatePort(value, fallback = 80, label = 'Porta') {
  const port = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    const err = new Error(`${label} inválida (1-65535).`);
    err.statusCode = 400;
    throw err;
  }
  return port;
}

function validateSeconds(value, fallback = 5) {
  const sec = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isInteger(sec) || sec < 1 || sec > 60) {
    const err = new Error('Tempo de liberação deve ser entre 1 e 60 segundos.');
    err.statusCode = 400;
    throw err;
  }
  return sec;
}

export class DeviceService {
  constructor(store, controlId = null, toletus = null) {
    this.store = store;
    this.controlId = controlId;
    this.toletus = toletus;
  }

  listTurnstiles() {
    return this.store.all('SELECT * FROM turnstiles ORDER BY id ASC');
  }

  getTurnstile(id) {
    return this.store.get('SELECT * FROM turnstiles WHERE id = ?', [Number(id)]) || null;
  }

  getPrimaryTurnstile() {
    return (
      this.store.get('SELECT * FROM turnstiles WHERE active = 1 ORDER BY id ASC LIMIT 1') ||
      this.store.get('SELECT * FROM turnstiles ORDER BY id ASC LIMIT 1') ||
      null
    );
  }

  _normalizeTurnstilePayload(data, existing = null) {
    const name = String(data.name ?? existing?.name ?? '').trim();
    if (!name) {
      const err = new Error('Informe o nome da catraca.');
      err.statusCode = 400;
      throw err;
    }
    const driver = String(data.driver ?? existing?.driver ?? 'toletus').trim().toLowerCase();
    if (!TURNSTILE_DRIVERS.includes(driver)) {
      const err = new Error('Driver da catraca inválido (use toletus ou controlid).');
      err.statusCode = 400;
      throw err;
    }
    const ip = validateHost(data.ip ?? existing?.ip, 'IP da catraca');
    const port = validatePort(data.port ?? existing?.port, driver === 'toletus' ? 7878 : 80, 'Porta da catraca');
    const releaseSeconds = validateSeconds(data.release_seconds ?? existing?.release_seconds ?? 5);
    const defaultDirection = String(data.default_direction ?? existing?.default_direction ?? 'entry').trim().toLowerCase();
    if (!DIRECTIONS.includes(defaultDirection)) {
      const err = new Error('Direção padrão inválida (entry, exit ou both).');
      err.statusCode = 400;
      throw err;
    }
    const freeSide = String(data.free_side ?? existing?.free_side ?? 'none').trim().toLowerCase();
    if (!FREE_SIDES.includes(freeSide)) {
      const err = new Error('Lado liberado inválido (none, entry, exit ou both).');
      err.statusCode = 400;
      throw err;
    }
    const active = Object.hasOwn(data, 'active') ? (data.active ? 1 : 0) : (existing?.active ?? 1);
    return { name, driver, ip, port, release_seconds: releaseSeconds, default_direction: defaultDirection, free_side: freeSide, active };
  }

  _syncPrimaryTurnstileToSettings(turnstile) {
    const first = this.store.get('SELECT id FROM turnstiles ORDER BY id ASC LIMIT 1');
    if (!first || first.id !== turnstile.id) return;
    this.store.updateSettings({
      toletus_ip: turnstile.ip,
      toletus_port: String(turnstile.port),
      toletus_enabled: turnstile.driver === 'toletus' && turnstile.active ? 'true' : 'false',
      turnstile_release_seconds: String(turnstile.release_seconds),
      turnstile_direction: turnstile.default_direction,
      turnstile_free_side: turnstile.free_side,
    });
  }

  createTurnstile(data) {
    const norm = this._normalizeTurnstilePayload(data);
    const res = this.store.run(
      `INSERT INTO turnstiles (name, driver, ip, port, release_seconds, default_direction, free_side, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [norm.name, norm.driver, norm.ip, norm.port, norm.release_seconds, norm.default_direction, norm.free_side, norm.active],
    );
    const created = this.getTurnstile(res.lastInsertRowid);
    this._syncPrimaryTurnstileToSettings(created);
    return created;
  }

  updateTurnstile(id, data) {
    const existing = this.getTurnstile(id);
    if (!existing) {
      const err = new Error('Catraca não encontrada.');
      err.statusCode = 404;
      throw err;
    }
    const norm = this._normalizeTurnstilePayload(data, existing);
    this.store.run(
      `UPDATE turnstiles
       SET name = ?, driver = ?, ip = ?, port = ?, release_seconds = ?, default_direction = ?, free_side = ?, active = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [norm.name, norm.driver, norm.ip, norm.port, norm.release_seconds, norm.default_direction, norm.free_side, norm.active, existing.id],
    );
    const updated = this.getTurnstile(existing.id);
    this._syncPrimaryTurnstileToSettings(updated);
    return updated;
  }

  deleteTurnstile(id) {
    const existing = this.getTurnstile(id);
    if (!existing) {
      const err = new Error('Catraca não encontrada.');
      err.statusCode = 404;
      throw err;
    }
    const firstBefore = this.store.get('SELECT id FROM turnstiles ORDER BY id ASC LIMIT 1');
    const wasPrimary = firstBefore?.id === existing.id;
    this.store.transaction(() => {
      this.store.run('UPDATE readers SET turnstile_id = NULL WHERE turnstile_id = ?', [existing.id]);
      this.store.run('DELETE FROM turnstiles WHERE id = ?', [existing.id]);
    });
    if (wasPrimary) {
      const nextPrimary = this.store.get('SELECT * FROM turnstiles ORDER BY id ASC LIMIT 1');
      if (nextPrimary) {
        this._syncPrimaryTurnstileToSettings(nextPrimary);
      } else {
        this.store.updateSettings({ toletus_ip: '', toletus_enabled: 'false' });
      }
    }
    return { deleted: true, id: existing.id };
  }

  async testTurnstile(id) {
    const t = this.getTurnstile(id);
    if (!t) throw Object.assign(new Error('Catraca não encontrada.'), { statusCode: 404 });
    if (t.driver === 'toletus') {
      if (!this.toletus) throw new Error('Cliente Toletus indisponível.');
      return this.toletus.testConnection({ ip: t.ip, port: t.port, enabled: true });
    }
    const linkedReader = this.store.get('SELECT * FROM readers WHERE turnstile_id = ? AND active = 1 ORDER BY id ASC LIMIT 1', [t.id]);
    if (!this.controlId) throw new Error('Cliente Control iD indisponível.');
    return this.controlId.testConnection(linkedReader || { ip: t.ip, port: t.port });
  }

  async applyTurnstileConfig(id) {
    const t = this.getTurnstile(id);
    if (!t) throw Object.assign(new Error('Catraca não encontrada.'), { statusCode: 404 });
    if (t.driver !== 'toletus') {
      return { applied: false, driver: t.driver, message: 'Configuração salva no sistema (Control iD usa tempo do relé no leitor).' };
    }
    if (!this.toletus) throw new Error('Cliente Toletus indisponível.');
    const durationRes = await this.toletus.setReleaseDuration(t.release_seconds, { ip: t.ip, port: t.port, enabled: true });
    const flowRes = await this.toletus.setFlowControl(t.free_side, { ip: t.ip, port: t.port, enabled: true });
    return { applied: true, driver: 'toletus', release_seconds: t.release_seconds, free_side: t.free_side, durationRes, flowRes };
  }

  _maskReader(reader) {
    if (!reader) return reader;
    return { ...reader, password: reader.password ? '******' : '' };
  }

  listReaders({ includeSecret = false } = {}) {
    const rows = this.store.all(
      `SELECT r.*, t.name AS turnstile_name
       FROM readers r
       LEFT JOIN turnstiles t ON t.id = r.turnstile_id
       ORDER BY r.id ASC`,
    );
    return includeSecret ? rows : rows.map((r) => this._maskReader(r));
  }

  getReader(id, { includeSecret = false } = {}) {
    const row = this.store.get(
      `SELECT r.*, t.name AS turnstile_name
       FROM readers r
       LEFT JOIN turnstiles t ON t.id = r.turnstile_id
       WHERE r.id = ?`,
      [Number(id)],
    );
    if (!row) return null;
    return includeSecret ? row : this._maskReader(row);
  }

  _normalizeReaderPayload(data, existing = null) {
    const name = String(data.name ?? existing?.name ?? '').trim();
    if (!name) throw Object.assign(new Error('Informe o nome do leitor.'), { statusCode: 400 });
    const ip = validateHost(data.ip ?? existing?.ip, 'IP do leitor');
    const port = validatePort(data.port ?? existing?.port, 80, 'Porta do leitor');
    const username = String(data.username ?? existing?.username ?? 'admin').trim() || 'admin';
    const rawPass = data.password;
    const password = rawPass === undefined || rawPass === '******'
      ? (existing?.password || 'admin')
      : String(rawPass || 'admin');
    const actionMode = String(data.action_mode ?? existing?.action_mode ?? 'sec_box').trim();
    if (!ACTION_MODES.includes(actionMode)) {
      throw Object.assign(new Error('Modo de ação inválido (sec_box ou door).'), { statusCode: 400 });
    }
    const secboxId = Number(data.secbox_id ?? existing?.secbox_id ?? 65793) || 65793;
    const groupId = Number(data.group_id ?? existing?.group_id ?? 1) || 1;
    const direction = String(data.direction ?? existing?.direction ?? 'entry').trim().toLowerCase();
    if (!DIRECTIONS.includes(direction)) {
      throw Object.assign(new Error('Direção do leitor inválida (entry, exit ou both).'), { statusCode: 400 });
    }
    let turnstileId = Object.hasOwn(data, 'turnstile_id')
      ? (data.turnstile_id ? Number(data.turnstile_id) : null)
      : (existing?.turnstile_id ?? null);
    if (turnstileId !== null && !this.getTurnstile(turnstileId)) {
      throw Object.assign(new Error('Catraca vinculada não encontrada.'), { statusCode: 400 });
    }
    const active = Object.hasOwn(data, 'active') ? (data.active ? 1 : 0) : (existing?.active ?? 1);
    return { name, ip, port, username, password, action_mode: actionMode, secbox_id: secboxId, group_id: groupId, direction, turnstile_id: turnstileId, active };
  }

  _syncPrimaryReaderToSettings(reader) {
    const first = this.store.get('SELECT id FROM readers ORDER BY id ASC LIMIT 1');
    if (!first || first.id !== reader.id) return;
    this.store.updateSettings({
      controlid_ip: reader.ip,
      controlid_port: String(reader.port),
      controlid_user: reader.username,
      controlid_password: reader.password,
      controlid_action_mode: reader.action_mode,
      controlid_secbox_id: String(reader.secbox_id),
      controlid_group_id: String(reader.group_id),
    });
  }

  createReader(data) {
    const norm = this._normalizeReaderPayload(data);
    const res = this.store.run(
      `INSERT INTO readers (name, brand, ip, port, username, password, action_mode, secbox_id, group_id, direction, turnstile_id, active)
       VALUES (?, 'controlid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [norm.name, norm.ip, norm.port, norm.username, norm.password, norm.action_mode, norm.secbox_id, norm.group_id, norm.direction, norm.turnstile_id, norm.active],
    );
    const created = this.getReader(res.lastInsertRowid, { includeSecret: true });
    this._syncPrimaryReaderToSettings(created);
    return this._maskReader(created);
  }

  updateReader(id, data) {
    const existing = this.getReader(id, { includeSecret: true });
    if (!existing) throw Object.assign(new Error('Leitor não encontrado.'), { statusCode: 404 });
    const norm = this._normalizeReaderPayload(data, existing);
    this.store.run(
      `UPDATE readers
       SET name = ?, ip = ?, port = ?, username = ?, password = ?, action_mode = ?, secbox_id = ?, group_id = ?, direction = ?, turnstile_id = ?, active = ?,
           updated_at = datetime('now', 'localtime')
       WHERE id = ?`,
      [norm.name, norm.ip, norm.port, norm.username, norm.password, norm.action_mode, norm.secbox_id, norm.group_id, norm.direction, norm.turnstile_id, norm.active, existing.id],
    );
    const updated = this.getReader(existing.id, { includeSecret: true });
    this._syncPrimaryReaderToSettings(updated);
    return this._maskReader(updated);
  }

  deleteReader(id) {
    const existing = this.getReader(id);
    if (!existing) throw Object.assign(new Error('Leitor não encontrado.'), { statusCode: 404 });
    const firstBefore = this.store.get('SELECT id FROM readers ORDER BY id ASC LIMIT 1');
    const wasPrimary = firstBefore?.id === existing.id;
    this.store.run('DELETE FROM readers WHERE id = ?', [existing.id]);
    if (wasPrimary) {
      const nextPrimary = this.store.get('SELECT * FROM readers ORDER BY id ASC LIMIT 1');
      if (nextPrimary) {
        this._syncPrimaryReaderToSettings(nextPrimary);
      } else {
        this.store.updateSettings({ controlid_ip: '' });
      }
    }
    return { deleted: true, id: existing.id };
  }

  async testReader(id) {
    const reader = this.getReader(id, { includeSecret: true });
    if (!reader) throw Object.assign(new Error('Leitor não encontrado.'), { statusCode: 404 });
    if (!this.controlId) throw new Error('Cliente Control iD indisponível.');
    return this.controlId.testConnection(reader);
  }

  findReaderByRequest({ readerId = null, readerIp = null } = {}) {
    if (readerId !== null && readerId !== undefined && readerId !== '') {
      const parsedId = Number(readerId);
      if (!Number.isInteger(parsedId) || parsedId <= 0) return null;
      return this.store.get('SELECT * FROM readers WHERE id = ? AND active = 1', [parsedId]) || null;
    }
    const cleanIp = String(readerIp || '').replace(/^::ffff:/, '').trim();
    if (cleanIp) {
      const byIp = this.store.get('SELECT * FROM readers WHERE ip = ? AND active = 1 ORDER BY id ASC LIMIT 1', [cleanIp]);
      if (byIp) return byIp;
    }
    return this.store.get('SELECT * FROM readers WHERE active = 1 ORDER BY id ASC LIMIT 1') || null;
  }

  getAllowedCallbackIps() {
    const ips = new Set();
    const s = this.store.getSettings();
    if (s.controlid_ip) ips.add(String(s.controlid_ip).trim());
    for (const row of this.store.all('SELECT ip FROM readers WHERE active = 1')) {
      if (row.ip) ips.add(String(row.ip).trim());
    }
    return ips;
  }
}
