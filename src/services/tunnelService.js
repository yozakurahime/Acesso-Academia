import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

function resolveCloudflaredBin() {
  if (process.env.CLOUDFLARED_BIN && fs.existsSync(process.env.CLOUDFLARED_BIN)) {
    return process.env.CLOUDFLARED_BIN;
  }
  const candidates = [
    'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
    'C:\\Program Files\\cloudflared\\cloudflared.exe',
  ];
  return candidates.find((p) => fs.existsSync(p)) || 'cloudflared';
}

export function startCloudflareTunnel() {
  if (process.env.CLOUDFLARED_AUTO === '0') {
    return { stop() {} };
  }

  const tunnelName = process.env.CLOUDFLARED_TUNNEL || 'academia-oxigenio';
  const configPath = process.env.CLOUDFLARED_CONFIG || path.join(os.homedir(), '.cloudflared', `${tunnelName}.yml`);
  if (!fs.existsSync(configPath)) {
    console.log(`[CLOUDFLARE TUNNEL] Config não encontrada (${configPath}); túnel automático ignorado.`);
    return { stop() {} };
  }

  const bin = resolveCloudflaredBin();
  const MIN_BACKOFF_MS = 5000;
  const MAX_BACKOFF_MS = 60000;
  const STABLE_CONNECTION_MS = 30000;
  let stopped = false;
  let child = null;
  let restartTimer = null;
  let stableTimer = null;
  let backoffMs = MIN_BACKOFF_MS;

  const launch = () => {
    if (stopped) return;
    if (stableTimer) {
      clearTimeout(stableTimer);
      stableTimer = null;
    }
    const protocol = process.env.CLOUDFLARED_PROTOCOL || 'http2';
    const edgeIpVersion = process.env.CLOUDFLARED_EDGE_IP_VERSION || '4';
    child = spawn(
      bin,
      ['tunnel', '--protocol', protocol, '--edge-ip-version', edgeIpVersion, '--config', configPath, 'run', tunnelName],
      {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let connectedLogged = false;
    const onLine = (chunk) => {
      const text = String(chunk || '');
      if (!connectedLogged && text.includes('Registered tunnel connection')) {
        connectedLogged = true;
        console.log(`[CLOUDFLARE TUNNEL] Conectado (${tunnelName}).`);
        if (!stableTimer) {
          stableTimer = setTimeout(() => {
            backoffMs = MIN_BACKOFF_MS;
            stableTimer = null;
          }, STABLE_CONNECTION_MS);
          if (typeof stableTimer.unref === 'function') stableTimer.unref();
        }
      }
      if (text.includes('ERR ') && !text.includes('context canceled')) {
        console.warn('[CLOUDFLARE TUNNEL]', text.trim().split('\n')[0]);
      }
    };

    child.stdout?.on('data', onLine);
    child.stderr?.on('data', onLine);

    child.on('error', (err) => {
      console.warn(`[CLOUDFLARE TUNNEL] Não foi possível iniciar (${err.message}).`);
    });

    child.on('exit', (code) => {
      child = null;
      if (stableTimer) {
        clearTimeout(stableTimer);
        stableTimer = null;
      }
      if (!stopped) {
        const delayMs = backoffMs;
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        console.warn(`[CLOUDFLARE TUNNEL] Encerrado (código ${code ?? '-'}). Reiniciando em ${Math.round(delayMs / 1000)}s...`);
        restartTimer = setTimeout(launch, delayMs);
      }
    });
  };

  launch();

  return {
    stop() {
      stopped = true;
      if (stableTimer) clearTimeout(stableTimer);
      if (restartTimer) clearTimeout(restartTimer);
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {}
      }
    },
  };
}
