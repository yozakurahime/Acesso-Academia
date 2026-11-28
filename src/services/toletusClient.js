import net from 'node:net';

const TRANSIENT_TCP_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE']);

/**
 * Cliente TCP para catracas Toletus LiteNet / LiteNet2 (pacotes fixos de 20 bytes).
 * Prefixo: 0x53 | Comando (2 bytes little-endian) | Mensagem ASCII (16 bytes) | Sufixo: 0xC3
 */
export class ToletusClient {
  constructor(getSettingsFn) {
    this.getSettings = getSettingsFn;
    this._queues = new Map();
    this.lastSuccessAt = 0;
    this.lastError = null;
  }

  getConfig(override = null) {
    const s = this.getSettings();
    return {
      ip: override?.ip || s.toletus_ip || '192.168.100.242',
      port: Number(override?.port || s.toletus_port || 7878),
      enabled: override?.enabled ?? (s.toletus_enabled !== 'false'),
      mockMode: s.controlid_mock_mode === 'true',
    };
  }

  buildBinaryPacket(commandId, payloadBuffer = null) {
    const buf = Buffer.alloc(20, 0x00);
    buf[0] = 0x53;
    buf.writeUInt16LE(commandId, 1);
    if (payloadBuffer) {
      Buffer.from(payloadBuffer).copy(buf, 3, 0, Math.min(16, payloadBuffer.length));
    }
    buf[19] = 0xc3;
    return buf;
  }

  /**
   * Monta o pacote binario de 20 bytes no padrao Toletus LiteNet2.
   */
  buildPacket(commandId, message = '') {
    const buf = Buffer.alloc(20, 0x00);
    buf[0] = 0x53; // Prefixo fixo (83)
    buf.writeUInt16LE(commandId, 1);

    const cleanMsg = String(message || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^\x20-\x7E]/g, '')
      .toUpperCase()
      .slice(0, 16);
    buf.write(cleanMsg, 3, 'ascii');

    buf[19] = 0xc3; // Sufixo fixo (195)
    return buf;
  }

  async sendPacket(packet, override = null) {
    const cfg = this.getConfig(override);
    const key = `${cfg.ip}:${cfg.port}`;
    const prev = this._queues.get(key) || Promise.resolve();
    const run = () => this._sendPacketWithRetry(packet, override);
    const next = prev.then(run, run);
    const tail = next.catch(() => {});
    this._queues.set(key, tail);
    try {
      return await next;
    } finally {
      if (this._queues.get(key) === tail) {
        this._queues.delete(key);
      }
    }
  }

  _isTransientTcpError(err) {
    if (!err) return false;
    if (err.code && TRANSIENT_TCP_CODES.has(err.code)) return true;
    const msg = String(err.message || '');
    return /ECONNRESET|ETIMEDOUT|ECONNABORTED|EPIPE|Timeout ao conectar/i.test(msg);
  }

  async _sendPacketWithRetry(packet, override = null) {
    try {
      return await this._sendPacketOnce(packet, override);
    } catch (err) {
      if (!this._isTransientTcpError(err)) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 50));
      return this._sendPacketOnce(packet, override);
    }
  }

  _sendPacketOnce(packet, override = null) {
    const cfg = this.getConfig(override);
    if (cfg.mockMode) {
      return Promise.resolve({
        ok: true,
        mock: true,
        ip: cfg.ip,
        port: cfg.port,
        packetHex: packet.toString('hex'),
      });
    }
    if (cfg.enabled === false) {
      return Promise.resolve({
        ok: false,
        skipped: true,
        disabled: true,
        ip: cfg.ip,
        port: cfg.port,
        message: 'Integração Toletus desativada.',
      });
    }

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      let ackTimer = null;

      const finish = (err, data = null) => {
        if (settled) return;
        settled = true;
        if (ackTimer) {
          clearTimeout(ackTimer);
          ackTimer = null;
        }
        socket.destroy();
        if (err) {
          this.lastError = err.message || 'Erro TCP Toletus';
          reject(err);
        } else {
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          resolve(data);
        }
      };

      socket.setTimeout(4000);
      socket.on('timeout', () => finish(Object.assign(new Error(`Timeout ao conectar na catraca Toletus (${cfg.ip}:${cfg.port}).`), { code: 'ETIMEDOUT' })));
      socket.on('error', (err) => finish(Object.assign(new Error(`Erro TCP Toletus (${cfg.ip}:${cfg.port}): ${err.message}`), { code: err.code })));

      socket.connect(cfg.port, cfg.ip, () => {
        socket.write(packet, (writeErr) => {
          if (writeErr) {
            return finish(writeErr);
          }
          // Aguarda breve resposta da placa ou confirma envio
          ackTimer = setTimeout(() => {
            finish(null, {
              ok: true,
              mock: false,
              ip: cfg.ip,
              port: cfg.port,
              packetHex: packet.toString('hex'),
            });
          }, 150);
        });
      });

      socket.on('data', (chunk) => {
        finish(null, {
          ok: true,
          mock: false,
          ip: cfg.ip,
          port: cfg.port,
          responseHex: chunk.toString('hex'),
        });
      });
    });
  }

  async testConnection(override = null) {
    const cfg = this.getConfig(override);
    if (cfg.mockMode) {
      return {
        connected: true,
        mock: true,
        message: `Modo simulado ativo para Toletus (${cfg.ip}:${cfg.port}).`,
      };
    }
    if (cfg.enabled === false) {
      return {
        connected: false,
        disabled: true,
        message: `Integração Toletus desativada (${cfg.ip}:${cfg.port}).`,
      };
    }

    return new Promise((resolve, reject) => {
      const socket = new net.Socket();
      let settled = false;
      const done = (err, res) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (err) {
          this.lastError = err.message || 'Erro TCP Toletus';
          reject(err);
        } else {
          this.lastSuccessAt = Date.now();
          this.lastError = null;
          resolve(res);
        }
      };

      socket.setTimeout(3000);
      socket.on('timeout', () => done(new Error(`Timeout ao testar Toletus (${cfg.ip}:${cfg.port}).`)));
      socket.on('error', (err) => done(new Error(`Nao foi possivel conectar na Toletus (${cfg.ip}:${cfg.port}): ${err.message}`)));
      socket.connect(cfg.port, cfg.ip, () => {
        done(null, {
          connected: true,
          mock: false,
          message: `Catraca Toletus conectada com sucesso em ${cfg.ip}:${cfg.port}!`,
        });
      });
    });
  }

  /** Libera entrada (0x0001) com mensagem opcional no display da catraca. */
  async releaseEntry(message = 'BEM VINDO', override = null) {
    const packet = this.buildPacket(0x0001, message);
    return this.sendPacket(packet, override);
  }

  /** Libera saida (0x0002). */
  async releaseExit(message = 'ATE LOGO', override = null) {
    const packet = this.buildPacket(0x0002, message);
    return this.sendPacket(packet, override);
  }

  /** Libera entrada, saida ou ambos os lados. */
  async releaseDirection(direction = 'entry', message = 'LIBERADO', override = null) {
    if (direction === 'exit') return this.releaseExit(message, override);
    if (direction === 'both') {
      const entry = await this.releaseEntry(message, override);
      const exit = await this.releaseExit(message, override);
      return { ok: true, direction: 'both', entry, exit };
    }
    return this.releaseEntry(message, override);
  }

  /** Configura o tempo de liberacao (0x020A) em milissegundos na placa LiteNet2. */
  async setReleaseDuration(seconds = 5, override = null) {
    const ms = Math.max(1000, Math.min(60000, Math.round(Number(seconds || 5) * 1000)));
    const payload = Buffer.alloc(16, 0x00);
    payload.writeUInt32LE(ms, 0);
    return this.sendPacket(this.buildBinaryPacket(0x020a, payload), override);
  }

  /** Configura o controle de fluxo / lado liberado (0x0202): both=0, exit=1, entry=2, none=3. */
  async setFlowControl(freeSide = 'none', override = null) {
    const modes = { both: 0, exit: 1, entry: 2, none: 3 };
    const code = Object.hasOwn(modes, freeSide) ? modes[freeSide] : 3;
    const payload = Buffer.alloc(16, 0x00);
    payload[0] = code;
    return this.sendPacket(this.buildBinaryPacket(0x0202, payload), override);
  }
}
