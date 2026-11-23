export function matchesDeviceIdentity(member, user) {
  const normalize = (value) => String(value ?? '').normalize('NFD').replace(/\p{M}/gu, '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
  const cpf = (value) => {
    const text = String(value ?? '').trim();
    const digits = text.replace(/\D/g, '');
    return /^[\d.\- ]+$/.test(text) && digits.length === 11 ? digits : '';
  };
  const localCpf = cpf(member.document);
  const readerCpf = cpf(user.registration);
  if (localCpf && readerCpf) return localCpf === readerCpf;
  return Boolean(normalize(member.name) && normalize(member.name) === normalize(user.name));
}

/**
 * Cliente HTTP para a API REST (.fcgi) dos equipamentos Control iD (iDFace / linha Acesso).
 * Documentacao oficial: https://www.controlid.com.br/docs/access-api-pt/
 */
export class ControlIdClient {
  constructor(getSettingsFn) {
    this.getSettings = getSettingsFn;
    this.session = null;
    this.lastBaseUrl = null;
    this._loginPromise = null;
    this._accessQueues = new Map();
    this._deviceClients = new Map();
  }

  forDevice(override) {
    if (!override) return this;
    const hasCustomGetConfig = this.getConfig !== ControlIdClient.prototype.getConfig;
    const baseSettings = hasCustomGetConfig ? null : this.getSettings();
    const baseCfg = hasCustomGetConfig ? this.getConfig() : null;
    const ip = String(override.ip ?? baseSettings?.controlid_ip ?? '').trim();
    const port = String(override.port ?? baseSettings?.controlid_port ?? '80');
    const user = String(override.username ?? override.user ?? baseSettings?.controlid_user ?? baseCfg?.user ?? 'admin');
    const key = `${ip}:${port}:${user}`;

    const cached = this._deviceClients.get(key);
    if (cached) {
      cached._deviceOverride = override;
      return cached;
    }

    const client = new ControlIdClient(() => {
      const s = this.getSettings();
      const ov = client._deviceOverride;
      return {
        ...s,
        controlid_ip: ov.ip ?? s.controlid_ip,
        controlid_port: String(ov.port ?? s.controlid_port ?? '80'),
        controlid_user: ov.username ?? ov.user ?? s.controlid_user,
        controlid_password: ov.password ?? s.controlid_password,
        controlid_action_mode: ov.action_mode ?? s.controlid_action_mode,
        controlid_secbox_id: String(ov.secbox_id ?? s.controlid_secbox_id ?? '65793'),
        controlid_group_id: String(ov.group_id ?? s.controlid_group_id ?? '1'),
      };
    });
    client._deviceOverride = override;

    if (hasCustomGetConfig) {
      client.getConfig = () => {
        const base = this.getConfig();
        const ov = client._deviceOverride;
        const ovIp = ov.ip !== undefined ? String(ov.ip || '').trim() : null;
        const ovPort = ov.port !== undefined && ov.port !== null && ov.port !== '' ? String(ov.port) : null;
        const baseUrl = ovIp
          ? `http://${ovIp}${ovPort && ovPort !== '80' ? `:${ovPort}` : ''}`
          : base.baseUrl;
        return {
          ...base,
          baseUrl,
          user: ov.username ?? ov.user ?? base.user,
          password: ov.password ?? base.password,
          actionMode: ov.action_mode ?? base.actionMode,
          secboxId: ov.secbox_id !== undefined ? Number(ov.secbox_id) : base.secboxId,
          groupId: ov.group_id !== undefined ? Number(ov.group_id) : base.groupId,
        };
      };
    }

    this._deviceClients.set(key, client);
    return client;
  }

  getConfig() {
    const s = this.getSettings();
    const ip = String(s.controlid_ip || '').trim();
    const port = s.controlid_port && s.controlid_port !== '80' ? `:${s.controlid_port}` : '';
    return {
      baseUrl: ip ? `http://${ip}${port}` : '',
      user: s.controlid_user || 'admin',
      password: s.controlid_password || 'admin',
      actionMode: s.controlid_action_mode || 'sec_box',
      secboxId: Number(s.controlid_secbox_id || 65793),
      groupId: Number(s.controlid_group_id || 1),
      mockMode: s.controlid_mock_mode === 'true',
    };
  }

  async requestRaw(endpoint, { method = 'POST', headers = {}, body = null, query = '' } = {}, retryAuth = true) {
    const cfg = this.getConfig();
    if (!cfg.baseUrl) {
      throw new Error('IP do leitor Control iD não configurado.');
    }
    if (this.lastBaseUrl !== cfg.baseUrl) {
      this.session = null;
      this.lastBaseUrl = cfg.baseUrl;
    }

    if (!this.session && endpoint !== '/login.fcgi') {
      await this.login();
    }

    const usedSession = this.session;
    const sessionParam = endpoint === '/login.fcgi' ? '' : `session=${encodeURIComponent(usedSession)}`;
    const qs = [sessionParam, query].filter(Boolean).join('&');
    const url = `${cfg.baseUrl}${endpoint}${qs ? `?${qs}` : ''}`;

    const response = await fetch(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(5000),
    });

    if (response.status === 401 && retryAuth && endpoint !== '/login.fcgi') {
      if (this.session === usedSession) {
        this.session = null;
      }
      await this.login();
      return this.requestRaw(endpoint, { method, headers, body, query }, false);
    }

    const text = await response.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }

    if (!response.ok) {
      throw new Error(`Control iD HTTP ${response.status}: ${json?.error || text || 'Erro desconhecido'}`);
    }

    return json;
  }

  async requestJson(endpoint, payload, query = '') {
    return this.requestRaw(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      query,
    });
  }

  async ensureSession() {
    const cfg = this.getConfig();
    if (this.lastBaseUrl !== cfg.baseUrl) {
      this.session = null;
      this.lastBaseUrl = cfg.baseUrl;
    }
    if (!this.session) {
      await this.login();
    }
    return this.session;
  }

  async login() {
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = (async () => {
      const cfg = this.getConfig();
      if (cfg.mockMode) {
        this.session = 'mock-session-token';
        return { session: this.session, mock: true };
      }

      const data = await this.requestJson('/login.fcgi', {
        login: cfg.user,
        password: cfg.password,
      });

      if (!data?.session) {
        throw new Error('Control iD nao retornou token de sessao no login.');
      }

      this.session = data.session;
      this.lastBaseUrl = cfg.baseUrl;
      return data;
    })();

    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  async testConnection(override = null) {
    if (override) return this.forDevice(override).testConnection();
    const cfg = this.getConfig();
    if (cfg.mockMode) {
      return {
        connected: true,
        mock: true,
        baseUrl: cfg.baseUrl,
        message: 'Modo simulado ativo (sem comunicacao fisica com a catraca).',
      };
    }

    this.session = null;
    await this.login();
    const groups = await this.requestJson('/load_objects.fcgi', { object: 'groups' });
    return {
      connected: true,
      mock: false,
      baseUrl: cfg.baseUrl,
      groups: groups?.groups || [],
      message: 'Conectado com sucesso ao leitor Control iD.',
    };
  }

  /**
   * Cria ou atualiza o usuario no equipamento e aplica a permissao de grupo.
   * @param {{ id: number, name: string, document?: string }} member
   * @param {boolean} allowed
   */
  async syncMember(member, allowed, options = {}) {
    const cfg = this.getConfig();
    const deviceUserId = member.controlid_user_id || member.id;

    if (cfg.mockMode) {
      return { controlIdUserId: deviceUserId, allowed, mock: true };
    }

    return this._enqueueUserAccess(deviceUserId, () => this._syncMemberOnce(member, deviceUserId, allowed, options));
  }

  async _syncMemberOnce(member, deviceUserId, allowed, { forceIdentityUpdate = false } = {}) {
    const existing = await this.getDeviceUser(deviceUserId);

    if (existing) {
      if (!forceIdentityUpdate && !matchesDeviceIdentity(member, existing)) {
        throw new Error('Nome ou CPF divergente no Control iD. Confira o vínculo facial antes de sincronizar.');
      }
      await this.requestJson('/modify_objects.fcgi', {
        object: 'users',
        values: {
          name: member.name,
          registration: member.document || String(member.id),
        },
        where: { users: { id: deviceUserId } },
      });
    } else {
      await this.requestJson('/create_objects.fcgi', {
        object: 'users',
        values: [
          {
            id: deviceUserId,
            name: member.name,
            registration: member.document || String(member.id),
          },
        ],
      });
    }

    await this._setUserAccessOnce(deviceUserId, allowed);
    return { controlIdUserId: deviceUserId, allowed, mock: false };
  }

  async getDeviceUser(id) {
    id = Number(id);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const result = await this.requestJson('/load_objects.fcgi', { object: 'users', where: { users: { id } } });
    return result.users?.find((user) => Number(user.id) === id) ?? null;
  }

  async _enqueueUserAccess(deviceUserId, fn) {
    const key = Number(deviceUserId) || deviceUserId;
    const prev = this._accessQueues.get(key) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this._accessQueues.set(key, tail);
    try {
      return await run;
    } finally {
      if (this._accessQueues.get(key) === tail) {
        this._accessQueues.delete(key);
      }
    }
  }

  /**
   * Controla se o usuario pertence ao grupo de acesso liberado (ex: grupo 1).
   * Mantem a biometria salva mesmo quando bloqueado por inadimplencia.
   */
  async setUserAccess(deviceUserId, allowed) {
    return this._enqueueUserAccess(deviceUserId, () => this._setUserAccessOnce(deviceUserId, allowed));
  }

  async _setUserAccessOnce(deviceUserId, allowed) {
    const cfg = this.getConfig();
    if (cfg.mockMode) {
      return { controlIdUserId: deviceUserId, allowed, mock: true };
    }

    await this.requestJson('/destroy_objects.fcgi', {
      object: 'user_groups',
      where: {
        user_groups: {
          user_id: deviceUserId,
          group_id: cfg.groupId,
        },
      },
    });

    if (allowed) {
      await this.requestJson('/create_objects.fcgi', {
        object: 'user_groups',
        values: [
          {
            user_id: deviceUserId,
            group_id: cfg.groupId,
          },
        ],
      });
    }

    return { controlIdUserId: deviceUserId, allowed, mock: false };
  }

  /**
   * Envia a foto JPEG da face para o leitor facial Control iD.
   */
  async uploadUserFace(deviceUserId, imageBuffer) {
    const cfg = this.getConfig();
    if (cfg.mockMode) {
      return { controlIdUserId: deviceUserId, uploaded: true, mock: true };
    }

    const timestamp = Math.floor(Date.now() / 1000);
    return this.requestRaw('/user_set_image.fcgi', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream' },
      body: imageBuffer,
      query: `user_id=${encodeURIComponent(deviceUserId)}&timestamp=${timestamp}&match=1`,
    });
  }

  /**
   * Baixa a foto JPEG da face armazenada no leitor Control iD.
   */
  async getUserImage(deviceUserId, retryAuth = true) {
    const cfg = this.getConfig();
    if (cfg.mockMode) return null;

    const usedSession = await this.ensureSession();
    const url = `${cfg.baseUrl}/user_get_image.fcgi?session=${encodeURIComponent(usedSession)}&user_id=${encodeURIComponent(deviceUserId)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (res.status === 401 && retryAuth) {
        if (this.session === usedSession) {
          this.session = null;
        }
        return this.getUserImage(deviceUserId, false);
      }
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 100) return null;
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Aciona manualmente o rele da catraca/porta (ex: botao na recepcao).
   */
  async releaseTurnstile(override = null) {
    if (override) return this.forDevice(override).releaseTurnstile();
    const cfg = this.getConfig();
    if (cfg.mockMode) {
      return { released: true, mode: cfg.actionMode, mock: true };
    }

    const action =
      cfg.actionMode === 'door'
        ? { action: 'door', parameters: 'door=1' }
        : { action: 'sec_box', parameters: `id=${cfg.secboxId}, reason=3` };

    return this.requestJson('/execute_actions.fcgi', {
      actions: [action],
    });
  }

  /**
   * Busca os ultimos logs de passagem registrados no leitor.
   */
  async fetchAccessLogs(limit = 50) {
    const cfg = this.getConfig();
    if (cfg.mockMode) {
      return [];
    }

    const data = await this.requestJson('/load_objects.fcgi', {
      object: 'access_logs',
      limit,
      order: ['descending', 'id'],
    });

    return data?.access_logs || [];
  }
}
