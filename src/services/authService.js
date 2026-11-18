import crypto from 'node:crypto';

const SESSION_COOKIE = 'acesso_session';
const STUDENT_SESSION_COOKIE = 'aluno_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const LOCAL_IPS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const ALLOWED_USER_ROLES = new Set(['admin', 'reception', 'instructor']);

export function requireRole(...roles) {
  return (req, res, next) => {
    const authActive = req.app?.locals?.authEnabled ?? (Boolean(req.authUser) || Boolean(req.authRole));
    if (!req.authUser && !req.authRole && !authActive) {
      return next();
    }
    const role = req.authRole || req.authUser?.role || (req.authUser ? 'admin' : null);
    if (!role) {
      return res.status(401).json({ error: 'Autenticação necessária.', code: 'AUTH_REQUIRED' });
    }
    if (role === 'admin' || roles.includes(role)) {
      return next();
    }
    return res.status(403).json({ error: 'Permissão insuficiente.', code: 'FORBIDDEN' });
  };
}

export function isLocalLoopbackRequest(req) {
  const remote = req?.socket?.remoteAddress;
  if (!remote || !LOCAL_IPS.has(remote)) return false;
  if (req.headers?.['x-forwarded-for'] || req.headers?.['cf-connecting-ip']) return false;
  const hostHeader = String(req.headers?.host || '').trim().toLowerCase();
  if (hostHeader) {
    const hostWithoutPort = hostHeader.startsWith('[')
      ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
      : hostHeader.split(':')[0];
    if (!['localhost', '127.0.0.1', '[::1]'].includes(hostWithoutPort)) {
      return false;
    }
  }
  return true;
}

function parseCookies(cookieHeader) {
  const out = {};
  if (!cookieHeader) return out;
  for (const part of String(cookieHeader).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try { out[key] = decodeURIComponent(val); } catch { /* Cookie inválido. */ }
    }
  }
  return out;
}

export function hashPassword(password) {
  const raw = String(password || '');
  if (raw.length < 8 || raw.length > 128) {
    throw new Error('A senha deve ter entre 8 e 128 caracteres.');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(raw, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password, storedHash) {
  if (!storedHash || !String(storedHash).includes(':')) return false;
  const [salt, hex] = String(storedHash).split(':');
  if (!salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const raw = String(password || '');
  if (raw.length > 128) return false;
  const actual = crypto.scryptSync(raw, salt, 64);
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

export class AuthService {
  constructor(store) {
    this.store = store;
  }

  getSecret() {
    const settings = this.store.getSettings();
    if (settings.auth_session_secret) {
      return settings.auth_session_secret;
    }
    const generated = crypto.randomBytes(32).toString('hex');
    this.store.updateSettings({ auth_session_secret: generated });
    return generated;
  }

  getAdminSecret() {
    return crypto.createHmac('sha256', this.getSecret()).update('admin-session-v1').digest();
  }

  getStudentSecret() {
    return crypto.createHmac('sha256', this.getSecret()).update('student-session-v1').digest();
  }

  rotateSessionSecret() {
    const generated = crypto.randomBytes(32).toString('hex');
    this.store.updateSettings({ auth_session_secret: generated });
  }

  revokeUserTokens(username) {
    const clean = String(username || '').trim();
    if (!clean) return;
    this.store.run(
      'UPDATE app_users SET token_version = COALESCE(token_version, 1) + 1 WHERE LOWER(TRIM(username)) = LOWER(?)',
      [clean],
    );
  }

  revokeStudentTokens(memberId) {
    this.store.run(
      'UPDATE members SET portal_token_version = COALESCE(portal_token_version, 1) + 1 WHERE id = ?',
      [Number(memberId)],
    );
  }

  isEnabled() {
    const s = this.store.getSettings();
    return s.auth_enabled === '1' && Boolean(s.auth_password_hash);
  }

  signToken(username, role = 'admin', tokenVersion = null) {
    const cleanRole = ALLOWED_USER_ROLES.has(role) ? role : 'admin';
    let tv = tokenVersion;
    if (tv === null || tv === undefined) {
      const appUser = this.store.get(
        'SELECT * FROM app_users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1',
        [String(username || '').trim()],
      );
      tv = appUser ? Number(appUser.token_version ?? 1) : null;
    }
    const payloadObj = { u: username, username, role: cleanRole, exp: Date.now() + SESSION_TTL_MS };
    if (tv !== null && tv !== undefined) payloadObj.tv = Number(tv);
    const payload = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
    const sig = crypto.createHmac('sha256', this.getAdminSecret()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyToken(token) {
    if (!token || !String(token).includes('.')) return null;
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', this.getAdminSecret()).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (!data?.u || !data?.exp || Date.now() > Number(data.exp)) return null;
      const appUser = this.store.get(
        'SELECT * FROM app_users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1',
        [String(data.u).trim()],
      );
      if (appUser) {
        if (!appUser.active) return null;
        const currentTv = Number(appUser.token_version ?? 1);
        if (data.tv !== undefined && Number(data.tv) !== currentTv) return null;
        data.role = appUser.role || data.role;
      } else {
        const settings = this.store.getSettings();
        const expectedAdminUser = String(settings.auth_username || 'admin').trim().toLowerCase();
        const isFallbackAdmin =
          settings.auth_enabled === '1' &&
          String(data.u).trim().toLowerCase() === expectedAdminUser &&
          data.tv === undefined;
        if (settings.auth_enabled === '1' && !isFallbackAdmin) {
          return null;
        }
      }
      return data;
    } catch {
      return null;
    }
  }

  getSessionFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return this.verifyToken(cookies[SESSION_COOKIE]);
  }

  setSessionCookie(req, res, username, role = null) {
    let resolvedRole = role;
    if (!resolvedRole) {
      const appUser = this.store.get(
        'SELECT role FROM app_users WHERE LOWER(TRIM(username)) = LOWER(?) AND active = 1 LIMIT 1',
        [String(username || '').trim()],
      );
      resolvedRole = appUser?.role || 'admin';
    }
    const token = this.signToken(username, resolvedRole);
    const isHttps = req.secure || req.headers?.['x-forwarded-proto'] === 'https';
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearSessionCookie(res) {
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  signStudentToken(memberId, tokenVersion = null) {
    let version = tokenVersion;
    if (version === null || version === undefined) {
      const row = this.store.get('SELECT portal_token_version FROM members WHERE id = ?', [Number(memberId)]);
      version = Number(row?.portal_token_version ?? 1);
    }
    const payload = Buffer.from(
      JSON.stringify({ m: Number(memberId), role: 'student', v: Number(version), exp: Date.now() + SESSION_TTL_MS }),
      'utf8',
    ).toString('base64url');
    const sig = crypto.createHmac('sha256', this.getStudentSecret()).update(payload).digest('base64url');
    return `${payload}.${sig}`;
  }

  verifyStudentToken(token) {
    if (!token || !String(token).includes('.')) return null;
    const [payload, sig] = String(token).split('.');
    if (!payload || !sig) return null;
    const expectedSig = crypto.createHmac('sha256', this.getStudentSecret()).update(payload).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (data?.role !== 'student' || !data?.m || !data?.exp || Date.now() > Number(data.exp)) return null;
      const member = this.store.get(
        "SELECT portal_token_version FROM members WHERE id = ? AND access_role = 'student'",
        [Number(data.m)],
      );
      if (!member || Number(member.portal_token_version ?? 1) !== Number(data.v)) {
        return null;
      }
      return data;
    } catch {
      return null;
    }
  }

  getStudentSessionFromRequest(req) {
    const cookies = parseCookies(req.headers?.cookie);
    return this.verifyStudentToken(cookies[STUDENT_SESSION_COOKIE]);
  }

  setStudentSessionCookie(req, res, memberId) {
    const token = this.signStudentToken(memberId);
    const isHttps = req.secure || req.headers?.['x-forwarded-proto'] === 'https';
    const parts = [
      `${STUDENT_SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/',
      'HttpOnly',
      'SameSite=Lax',
      `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    ];
    if (isHttps) parts.push('Secure');
    res.setHeader('Set-Cookie', parts.join('; '));
  }

  clearStudentSessionCookie(res) {
    res.setHeader('Set-Cookie', `${STUDENT_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
  }

  studentMiddleware() {
    return (req, res, next) => {
      const session = this.getStudentSessionFromRequest(req);
      if (!session?.m) {
        return res.status(401).json({ error: 'Sessão do aluno necessária.', code: 'STUDENT_AUTH_REQUIRED' });
      }
      req.studentMemberId = Number(session.m);
      return next();
    };
  }

  listUsers() {
    return this.store.all(
      'SELECT id, username, role, staff_id, active, created_at FROM app_users ORDER BY id ASC',
    );
  }

  createUser({ username, password, role = 'reception', staff_id = null } = {}) {
    const cleanUser = String(username || '').trim();
    if (!cleanUser || !/^[a-zA-Z0-9._-]{2,64}$/.test(cleanUser)) {
      const err = new Error('Informe um nome de usuário válido (2-64 caracteres, sem espaços).');
      err.statusCode = 400;
      throw err;
    }
    const cleanRole = String(role || 'reception').trim().toLowerCase();
    if (!ALLOWED_USER_ROLES.has(cleanRole)) {
      const err = new Error('Perfil inválido. Escolha admin, reception ou instructor.');
      err.statusCode = 400;
      throw err;
    }
    const existing = this.store.get(
      'SELECT id FROM app_users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1',
      [cleanUser],
    );
    if (existing) {
      const err = new Error('Já existe um usuário com esse nome.');
      err.statusCode = 409;
      throw err;
    }
    const passwordHash = hashPassword(password);
    const staffIdVal = staff_id ? Number(staff_id) : null;
    const res = this.store.run(
      'INSERT INTO app_users (username, password_hash, role, staff_id, active) VALUES (?, ?, ?, ?, 1)',
      [cleanUser, passwordHash, cleanRole, staffIdVal],
    );
    return this.store.get(
      'SELECT id, username, role, staff_id, active, created_at FROM app_users WHERE id = ?',
      [res.lastInsertRowid],
    );
  }

  updateUser(id, { role, active, password, staff_id } = {}) {
    const userId = Number(id);
    const existing = this.store.get('SELECT * FROM app_users WHERE id = ?', [userId]);
    if (!existing) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }

    const sets = [];
    const params = [];

    if (role !== undefined) {
      const cleanRole = String(role).trim().toLowerCase();
      if (!ALLOWED_USER_ROLES.has(cleanRole)) {
        const err = new Error('Perfil inválido. Escolha admin, reception ou instructor.');
        err.statusCode = 400;
        throw err;
      }
      sets.push('role = ?');
      params.push(cleanRole);
    }

    if (active !== undefined) {
      sets.push('active = ?');
      params.push(active ? 1 : 0);
    }

    if (staff_id !== undefined) {
      sets.push('staff_id = ?');
      params.push(staff_id ? Number(staff_id) : null);
    }

    if (password && String(password).length > 0) {
      sets.push('password_hash = ?');
      params.push(hashPassword(password));
    }

    if (
      Object.prototype.hasOwnProperty.call(existing, 'token_version') &&
      (role !== undefined || active !== undefined || (password && String(password).length > 0))
    ) {
      sets.push('token_version = COALESCE(token_version, 1) + 1');
    }

    if (sets.length > 0) {
      params.push(userId);
      this.store.run(`UPDATE app_users SET ${sets.join(', ')} WHERE id = ?`, params);
    }

    return this.store.get(
      'SELECT id, username, role, staff_id, active, created_at FROM app_users WHERE id = ?',
      [userId],
    );
  }

  deleteUser(id) {
    const userId = Number(id);
    const res = this.store.run('DELETE FROM app_users WHERE id = ?', [userId]);
    if (!res.changes) {
      const err = new Error('Usuário não encontrado.');
      err.statusCode = 404;
      throw err;
    }
    return { deleted: true, id: userId };
  }

  authenticateUser(username, password) {
    const givenUser = String(username || '').trim().toLowerCase();
    if (!givenUser) return null;

    const appUser = this.store.get(
      'SELECT * FROM app_users WHERE LOWER(TRIM(username)) = LOWER(?) LIMIT 1',
      [givenUser],
    );
    if (appUser) {
      if (!appUser.active) return null;
      if (!verifyPassword(password, appUser.password_hash)) return null;
      return {
        id: appUser.id,
        username: appUser.username,
        role: appUser.role || 'reception',
        staff_id: appUser.staff_id ?? null,
      };
    }

    const s = this.store.getSettings();
    const expectedUser = String(s.auth_username || 'admin').trim().toLowerCase();
    if (givenUser !== expectedUser) return null;
    if (!verifyPassword(password, s.auth_password_hash)) return null;
    return {
      id: null,
      username: s.auth_username || 'admin',
      role: 'admin',
      staff_id: null,
    };
  }

  authenticate(username, password) {
    return Boolean(this.authenticateUser(username, password));
  }

  requireRole(...roles) {
    return (req, res, next) => {
      if (!this.isEnabled()) {
        return next();
      }
      if (!req.authUser && !req.authRole) {
        return res.status(401).json({ error: 'Autenticação necessária.', code: 'AUTH_REQUIRED' });
      }
      return requireRole(...roles)(req, res, next);
    };
  }

  configure({ enabled, username, password }) {
    const s = this.store.getSettings();
    const cleanUser = String(username || s.auth_username || 'admin').trim();
    if (!cleanUser) {
      throw new Error('Informe um nome de usuário válido.');
    }

    const updates = {
      auth_username: cleanUser,
      auth_enabled: enabled ? '1' : '0',
      auth_session_secret: crypto.randomBytes(32).toString('hex'),
    };

    if (password && String(password).length > 0) {
      updates.auth_password_hash = hashPassword(password);
    } else if (enabled && !s.auth_password_hash) {
      throw new Error('Defina uma senha antes de ativar o login.');
    }

    this.store.updateSettings(updates);
    return {
      enabled: this.isEnabled(),
      username: cleanUser,
    };
  }

  middleware() {
    return (req, res, next) => {
      const p = req.path || '';
      if (
        p === '/auth/status' ||
        p === '/auth/login' ||
        p === '/auth/logout' ||
        p.startsWith('/student/') ||
        p.startsWith('/webhooks/') ||
        p === '/members/webhook' ||
        p.endsWith('.fcgi')
      ) {
        return next();
      }
      if (!this.isEnabled()) {
        if (!isLocalLoopbackRequest(req)) {
          return res.status(401).json({ error: 'Configure o login administrativo no computador da recepção.', code: 'AUTH_REQUIRED' });
        }
        return next();
      }

      const session = this.getSessionFromRequest(req);
      if (!session) {
        return res.status(401).json({ error: 'Autenticação necessária.', code: 'AUTH_REQUIRED' });
      }
      req.authUser = session.u;
      req.authRole = session.role || 'admin';
      req.auth = { username: session.u, role: req.authRole };
      return next();
    };
  }
}
