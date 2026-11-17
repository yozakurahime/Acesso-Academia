import fs from 'node:fs';
import path from 'node:path';

function httpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export class BackupService {
  constructor(store, backupDir) {
    this.store = store;
    this.backupDir = path.resolve(backupDir);
  }

  createBackup({ maxKeep = 30 } = {}) {
    fs.mkdirSync(this.backupDir, { recursive: true });
    const now = new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const filename = `oxigenio-${stamp}.sqlite`;
    const targetPath = path.join(this.backupDir, filename);

    const data = this.store.db.export();
    fs.writeFileSync(targetPath, Buffer.from(data), { flush: true });

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
