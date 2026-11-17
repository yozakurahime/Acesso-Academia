import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&supportsAllDrives=true';
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';

function base64Url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

/**
 * Servico de sincronizacao automatica de backups com o Google Drive
 * (suporta API do Google Drive via OAuth2/Service Account ou pasta local sincronizada).
 */
export class GoogleDriveBackupService {
  constructor(store, { fetchImpl = globalThis.fetch } = {}) {
    this.store = store;
    this.fetchImpl = fetchImpl;
  }

  _updateStatus({ lastAt = null, lastFile = null, error = '' }) {
    const updates = { backup_gdrive_last_error: String(error || '') };
    if (lastAt) updates.backup_gdrive_last_at = lastAt;
    if (lastFile) updates.backup_gdrive_last_file = lastFile;
    this.store.updateSettings(updates);
  }

  buildAuthUrl(redirectUri) {
    const settings = this.store.getSettings();
    const clientId = String(settings.backup_gdrive_client_id || '').trim();
    if (!clientId) {
      throw Object.assign(new Error('Informe o Client ID do Google OAuth2 antes de conectar.'), { statusCode: 400 });
    }
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: DRIVE_SCOPE,
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${OAUTH_AUTH_URL}?${params.toString()}`;
  }

  async exchangeAuthCode(code, redirectUri) {
    const settings = this.store.getSettings();
    const clientId = String(settings.backup_gdrive_client_id || '').trim();
    const clientSecret = String(settings.backup_gdrive_client_secret || '').trim();
    if (!clientId || !clientSecret) {
      throw Object.assign(new Error('Client ID e Client Secret do Google OAuth2 são obrigatórios.'), { statusCode: 400 });
    }
    const body = new URLSearchParams({
      code: String(code || '').trim(),
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    });
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.refresh_token) {
      const msg = data.error_description || data.error || 'Falha ao obter refresh_token do Google.';
      throw Object.assign(new Error(msg), { statusCode: 502 });
    }
    this.store.updateSettings({
      backup_gdrive_refresh_token: data.refresh_token,
      backup_gdrive_mode: 'api',
      backup_gdrive_enabled: 'true',
      backup_gdrive_last_error: '',
    });
    return { connected: true };
  }

  async getAccessToken(settings = this.store.getSettings()) {
    const saRaw = String(settings.backup_gdrive_service_account_json || '').trim();
    if (saRaw) {
      let sa;
      try {
        sa = JSON.parse(saRaw);
      } catch {
        throw new Error('JSON da Service Account do Google Drive inválido.');
      }
      if (!sa.client_email || !sa.private_key) {
        throw new Error('JSON da Service Account deve conter client_email e private_key.');
      }
      const now = Math.floor(Date.now() / 1000);
      const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
      const claim = base64Url(JSON.stringify({
        iss: sa.client_email,
        scope: DRIVE_SCOPE,
        aud: OAUTH_TOKEN_URL,
        iat: now,
        exp: now + 3600,
      }));
      const unsigned = `${header}.${claim}`;
      const signer = crypto.createSign('RSA-SHA256');
      signer.update(unsigned);
      const sig = signer.sign(sa.private_key, 'base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
      const assertion = `${unsigned}.${sig}`;
      const body = new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      });
      const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.access_token) {
        throw new Error(data.error_description || data.error || 'Falha ao autenticar Service Account no Google.');
      }
      return data.access_token;
    }

    const clientId = String(settings.backup_gdrive_client_id || '').trim();
    const clientSecret = String(settings.backup_gdrive_client_secret || '').trim();
    const refreshToken = String(settings.backup_gdrive_refresh_token || '').trim();
    if (!clientId || !clientSecret || !refreshToken) {
      throw new Error('Configure OAuth2 (Client ID, Client Secret e Refresh Token) ou Service Account JSON do Google Drive.');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    });
    const res = await this.fetchImpl(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      throw new Error(data.error_description || data.error || 'Falha ao renovar token do Google Drive.');
    }
    return data.access_token;
  }

  syncLocalFolder(backupPath, targetDir, { maxKeep = 30 } = {}) {
    const dir = String(targetDir || '').trim();
    if (!dir) throw new Error('Informe o caminho da pasta local do Google Drive.');
    const resolvedDir = path.resolve(dir);
    fs.mkdirSync(resolvedDir, { recursive: true });

    const filename = path.basename(backupPath);
    const destPath = path.join(resolvedDir, filename);
    fs.copyFileSync(backupPath, destPath);

    const photosSrc = `${backupPath}.photos`;
    if (fs.existsSync(photosSrc) && fs.statSync(photosSrc).isDirectory()) {
      fs.cpSync(photosSrc, `${destPath}.photos`, { recursive: true, force: true });
    }

    const keep = Math.max(1, Math.floor(Number(maxKeep) || 30));
    const entries = fs
      .readdirSync(resolvedDir, { withFileTypes: true })
      .filter((e) => e.isFile() && /^oxigenio-.*\.sqlite$/i.test(e.name))
      .map((e) => ({ name: e.name, mtime: fs.statSync(path.join(resolvedDir, e.name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));

    for (const stale of entries.slice(keep)) {
      const stalePath = path.join(resolvedDir, stale.name);
      fs.rmSync(stalePath, { force: true });
      fs.rmSync(`${stalePath}.photos`, { recursive: true, force: true });
    }

    return { mode: 'local', filename, destination: destPath };
  }

  async uploadToDriveApi(backupPath, settings, { maxKeep = 30 } = {}) {
    const token = await this.getAccessToken(settings);
    const filename = path.basename(backupPath);
    const folderId = String(settings.backup_gdrive_folder_id || '').trim();
    const metadata = { name: filename, mimeType: 'application/x-sqlite3' };
    if (folderId) metadata.parents = [folderId];

    const fileBuffer = fs.readFileSync(backupPath);
    const boundary = `oxigenio_${crypto.randomBytes(12).toString('hex')}`;
    const head = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/x-sqlite3\r\n\r\n`,
      'utf8',
    );
    const tail = Buffer.from(`\r\n--${boundary}--`, 'utf8');
    const body = Buffer.concat([head, fileBuffer, tail]);

    const uploadRes = await this.fetchImpl(DRIVE_UPLOAD_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    const uploaded = await uploadRes.json().catch(() => ({}));
    if (!uploadRes.ok || !uploaded.id) {
      throw new Error(uploaded.error?.message || `Erro HTTP ${uploadRes.status} ao enviar backup ao Google Drive.`);
    }

    // Limpa backups antigos na pasta do Drive acima de maxKeep
    const keep = Math.max(1, Math.floor(Number(maxKeep) || 30));
    const qParts = ["name contains 'oxigenio-'", "name contains '.sqlite'", 'trashed = false'];
    if (folderId) qParts.push(`'${folderId.replace(/'/g, "\\'")}' in parents`);
    const listUrl = `${DRIVE_FILES_URL}?q=${encodeURIComponent(qParts.join(' and '))}` +
      `&orderBy=createdTime desc&pageSize=100&fields=files(id,name,createdTime)&supportsAllDrives=true&includeItemsFromAllDrives=true`;
    const listRes = await this.fetchImpl(listUrl, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (listRes.ok) {
      const listData = await listRes.json().catch(() => ({}));
      const files = Array.isArray(listData.files) ? listData.files : [];
      for (const stale of files.slice(keep)) {
        await this.fetchImpl(`${DRIVE_FILES_URL}/${encodeURIComponent(stale.id)}?supportsAllDrives=true`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${token}` },
        }).catch(() => {});
      }
    }

    return { mode: 'api', filename, fileId: uploaded.id };
  }

  async syncBackup(backup, { maxKeep = 30, force = false } = {}) {
    const settings = this.store.getSettings();
    const enabled = settings.backup_gdrive_enabled === 'true';
    if (!force && !enabled) {
      return { skipped: true, reason: 'disabled' };
    }
    if (!backup?.path || !fs.existsSync(backup.path)) {
      throw new Error('Arquivo de backup local não encontrado para envio.');
    }

    const mode = settings.backup_gdrive_mode === 'local' ? 'local' : 'api';
    try {
      const result = mode === 'local'
        ? this.syncLocalFolder(backup.path, settings.backup_gdrive_local_dir, { maxKeep })
        : await this.uploadToDriveApi(backup.path, settings, { maxKeep });
      const now = new Date().toISOString();
      this._updateStatus({ lastAt: now, lastFile: result.filename, error: '' });
      return { ok: true, synced_at: now, ...result };
    } catch (err) {
      this._updateStatus({ error: err.message });
      throw err;
    }
  }
}
