import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDesktopNotifier, formatTurnstileReleaseNotification } from '../src/services/desktopNotifier.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

test('formatTurnstileReleaseNotification formata aluno, origem, horario e aniversariante', () => {
  const payload = formatTurnstileReleaseNotification({
    memberName: 'Maria Silva',
    source: 'FaceID',
    occurredAt: '2026-11-17T14:05:09-03:00',
    isBirthday: true,
  });

  assert.match(payload.title, /^Catraca liberada · \d{2}:\d{2}:\d{2}$/);
  assert.equal(payload.body, 'Maria Silva\nFaceID · 🎂 Aniversariante');
  assert.equal(payload.level, 'info');
  assert.equal(payload.timeoutMs, 6000);
});

test('formatTurnstileReleaseNotification usa fallback para liberacao manual', () => {
  const payload = formatTurnstileReleaseNotification({});
  assert.match(payload.title, /^Catraca liberada · \d{2}:\d{2}:\d{2}$/);
  assert.equal(payload.body, 'Liberação manual\nCatraca');
});

test('createDesktopNotifier envia JSON por stdin no Windows e encerra com seguranca', () => {
  const written = [];
  let ended = false;
  let killed = false;
  let spawnedArgs = null;

  const fakeChild = new EventEmitter();
  fakeChild.killed = false;
  fakeChild.stderr = new EventEmitter();
  fakeChild.stdin = {
    destroyed: false,
    write(chunk) {
      written.push(chunk);
      return true;
    },
    end() {
      ended = true;
      this.destroyed = true;
    },
  };
  fakeChild.kill = () => {
    killed = true;
    fakeChild.killed = true;
  };

  const notifier = createDesktopNotifier({
    rootDir,
    port: 3000,
    platform: 'win32',
    enabled: true,
    spawnFn: (cmd, args) => {
      spawnedArgs = { cmd, args };
      return fakeChild;
    },
  });

  assert.equal(spawnedArgs.cmd, 'powershell.exe');
  assert.ok(spawnedArgs.args.includes(path.join(rootDir, 'scripts', 'desktop-notifier.ps1')));
  assert.equal(notifier.isActive(), true);

  const sent = notifier.notifyTurnstileRelease({
    memberName: 'João Pedro',
    source: 'Toletus',
    occurredAt: '2026-11-17T17:40:00-03:00',
    isBirthday: false,
  });
  assert.equal(sent, true);
  assert.equal(written.length, 1);

  const parsed = JSON.parse(written[0]);
  assert.equal(parsed.body, 'João Pedro\nToletus');

  notifier.stop();
  assert.equal(ended, true);
  assert.equal(killed, true);
  assert.equal(notifier.isActive(), false);
  assert.equal(notifier.notifyTurnstileRelease({ memberName: 'Teste' }), false);
});

test('createDesktopNotifier fica inativo fora do Windows ou quando desabilitado', () => {
  const linuxNotifier = createDesktopNotifier({ rootDir, platform: 'linux', enabled: true });
  assert.equal(linuxNotifier.isActive(), false);
  assert.equal(linuxNotifier.notifyTurnstileRelease({ memberName: 'Teste' }), false);

  const disabledNotifier = createDesktopNotifier({ rootDir, platform: 'win32', enabled: false });
  assert.equal(disabledNotifier.isActive(), false);
});
