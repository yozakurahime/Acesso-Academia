import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function formatTurnstileReleaseNotification(event = {}) {
  const name = String(event?.memberName || '').trim() || 'Liberação manual';
  const source = String(event?.source || '').trim() || 'Catraca';
  const occurredAt = event?.occurredAt ? new Date(event.occurredAt) : new Date();
  const validDate = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
  const timeText = validDate.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const birthdayTag = event?.isBirthday ? ' · 🎂 Aniversariante' : '';

  return {
    title: `Catraca liberada · ${timeText}`,
    body: `${name}\n${source}${birthdayTag}`,
    level: 'info',
    timeoutMs: 6000,
    memberId: Number(event?.memberId) > 0 ? Number(event.memberId) : null,
  };
}

export function formatTurnstileDeniedNotification(event = {}) {
  const name = String(event?.memberName || '').trim() || 'Não identificado';
  const reason = String(event?.reason || '').trim() || 'Acesso negado';
  const occurredAt = event?.occurredAt ? new Date(event.occurredAt) : new Date();
  const validDate = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
  const timeText = validDate.toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return {
    title: `Acesso bloqueado · ${timeText}`,
    body: `${name}\n${reason}`,
    level: 'error',
    timeoutMs: 7000,
    memberId: Number(event?.memberId) > 0 ? Number(event.memberId) : null,
  };
}

/**
 * Exibe notificações nativas na área de trabalho do Windows (independente do navegador)
 * usando um processo PowerShell persistente com NotifyIcon.
 */
export function createDesktopNotifier({
  rootDir,
  port = 3000,
  panelUrl = process.env.EDGE_CLOUD_URL || 'https://sistema.academiaoxigenio.com',
  platform = process.platform,
  enabled = process.env.OXIGENIO_DESKTOP_NOTIFICATIONS !== '0' && process.env.NODE_ENV !== 'test',
  spawnFn = spawn,
} = {}) {
  if (!enabled || platform !== 'win32' || !rootDir) {
    return {
      isActive: () => false,
      notify: () => false,
      notifyTurnstileRelease: () => false,
      notifyTurnstileDenied: () => false,
      stop: () => {},
    };
  }

  const scriptPath = path.join(rootDir, 'scripts', 'desktop-notifier.ps1');
  if (!fs.existsSync(scriptPath)) {
    console.warn('[NOTIFICACAO WINDOWS] Script não encontrado:', scriptPath);
    return {
      isActive: () => false,
      notify: () => false,
      notifyTurnstileRelease: () => false,
      notifyTurnstileDenied: () => false,
      stop: () => {},
    };
  }

  const iconPath = path.join(rootDir, 'public', 'oxigenio.jpg');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-STA',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    scriptPath,
    '-ServerPid',
    String(process.pid),
    '-Port',
    String(port),
  ];
  if (panelUrl && String(panelUrl).trim()) {
    args.push('-PanelUrl', String(panelUrl).trim());
  }
  if (fs.existsSync(iconPath)) {
    args.push('-IconPath', iconPath);
  }

  let child = null;
  let stopped = false;

  try {
    child = spawnFn('powershell.exe', args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    console.warn('[NOTIFICACAO WINDOWS] Falha ao iniciar notificador:', err.message);
    return {
      isActive: () => false,
      notify: () => false,
      notifyTurnstileRelease: () => false,
      notifyTurnstileDenied: () => false,
      stop: () => {},
    };
  }

  child.on('error', (err) => {
    console.warn('[NOTIFICACAO WINDOWS] Erro no notificador:', err.message);
  });

  child.stderr?.on('data', (chunk) => {
    const msg = String(chunk || '').trim();
    if (msg) console.warn('[NOTIFICACAO WINDOWS]', msg);
  });

  child.on('exit', (code) => {
    if (!stopped && code) {
      console.warn(`[NOTIFICACAO WINDOWS] Notificador encerrou com código ${code}.`);
    }
    child = null;
  });

  const isActive = () => Boolean(child && !stopped && !child.killed && child.stdin && !child.stdin.destroyed);

  const notify = (payload) => {
    if (!isActive() || !payload) return false;
    try {
      child.stdin.write(`${JSON.stringify(payload)}\n`, 'utf8');
      return true;
    } catch {
      return false;
    }
  };

  const notifyTurnstileRelease = (event) => notify(formatTurnstileReleaseNotification(event));
  const notifyTurnstileDenied = (event) => notify(formatTurnstileDeniedNotification(event));

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (!child) return;
    try {
      if (child.stdin && !child.stdin.destroyed) {
        child.stdin.end();
      }
    } catch {}
    try {
      if (!child.killed) {
        child.kill();
      }
    } catch {}
    child = null;
  };

  process.once('exit', stop);

  return {
    isActive,
    notify,
    notifyTurnstileRelease,
    notifyTurnstileDenied,
    stop,
  };
}
