import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../src/db.js';
import { BackupService } from '../src/services/backupService.js';
import { GoogleDriveBackupService } from '../src/services/googleDriveBackupService.js';

test('GoogleDriveBackupService sincroniza pasta local e mantém retenção', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-gdrive-local-'));
  try {
    const store = await DatabaseStore.create(null);
    const backupDir = path.join(tmpDir, 'backups');
    const driveDir = path.join(tmpDir, 'drive-sync');
    const backupService = new BackupService(store, backupDir);
    const gdrive = new GoogleDriveBackupService(store);

    const b1 = backupService.createBackup();
    const b2 = backupService.createBackup();
    store.updateSettings({
      backup_gdrive_enabled: 'true',
      backup_gdrive_mode: 'local',
      backup_gdrive_local_dir: driveDir,
    });

    await gdrive.syncBackup(b1, { maxKeep: 1 });
    const res = await gdrive.syncBackup(b2, { maxKeep: 1 });

    assert.equal(res.ok, true);
    assert.equal(res.mode, 'local');
    const files = fs.readdirSync(driveDir).filter((f) => f.endsWith('.sqlite'));
    assert.equal(files.length, 1);
    assert.equal(files[0], b2.filename);
    assert.equal(store.getSettings().backup_gdrive_last_file, b2.filename);
    assert.equal(store.getSettings().backup_gdrive_last_error, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('GoogleDriveBackupService envia backup via Drive API v3 (OAuth2) e limpa antigos', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oxigenio-gdrive-api-'));
  try {
    const store = await DatabaseStore.create(null);
    const backupService = new BackupService(store, path.join(tmpDir, 'backups'));
    const backup = backupService.createBackup();

    const calls = [];
    const fetchMock = async (url, opts = {}) => {
      calls.push({ url, method: opts.method || 'GET', headers: opts.headers || {} });
      if (url.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'tok-123' }), { status: 200 });
      }
      if (url.includes('/upload/drive/v3/files')) {
        return new Response(JSON.stringify({ id: 'file-new' }), { status: 200 });
      }
      if (url.includes('/drive/v3/files?q=')) {
        return new Response(
          JSON.stringify({ files: [{ id: 'file-new' }, { id: 'file-old' }] }),
          { status: 200 },
        );
      }
      if (url.includes('/drive/v3/files/file-old') && opts.method === 'DELETE') {
        return new Response('', { status: 204 });
      }
      return new Response('{}', { status: 404 });
    };

    const gdrive = new GoogleDriveBackupService(store, { fetchImpl: fetchMock });
    store.updateSettings({
      backup_gdrive_enabled: 'true',
      backup_gdrive_mode: 'api',
      backup_gdrive_folder_id: 'folder-abc',
      backup_gdrive_client_id: 'cid',
      backup_gdrive_client_secret: 'csec',
      backup_gdrive_refresh_token: 'rtok',
    });

    const res = await gdrive.syncBackup(backup, { maxKeep: 1 });
    assert.equal(res.ok, true);
    assert.equal(res.mode, 'api');
    assert.equal(res.fileId, 'file-new');
    assert.ok(calls.some((c) => c.url.includes('/upload/drive/v3/files') && c.method === 'POST'));
    assert.ok(calls.some((c) => c.url.includes('/drive/v3/files/file-old') && c.method === 'DELETE'));
    assert.equal(store.getSettings().backup_gdrive_last_file, backup.filename);
    assert.equal(store.getSettings().backup_gdrive_last_error, '');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
