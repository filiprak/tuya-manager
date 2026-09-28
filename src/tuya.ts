// Tuya LAN protocol (v3.1 / v3.3), TypeScript port of tinytuya:
//   core/crypto_helper.py  -> aesEcbEncrypt/aesEcbDecrypt (AES-128-ECB, PKCS#7)
//   core/header.py         -> prefix/suffix constants, commands without version header
//   core/message_helper.py -> packMessage/unpackMessage (55AA frame + CRC32)
//   core/XenonDevice.py    -> TuyaDevice encode/decode/status/setDps
//   core/udp_helper.py     -> decryptUdp (scan broadcasts, key = md5("yGAdlopoPVldABfn"))
//   BulbDevice.py          -> detectSwitchDp (DP 20 for type B, DP 1 for A/C)
//   scanner.py             -> scan() listening on UDP 6666/6667/7000

import crypto from 'node:crypto';
import net from 'node:net';
import dgram from 'node:dgram';

export const CONTROL = 7;
export const DP_QUERY = 0x0a;
export const CONTROL_NEW = 0x0d;
export const DP_QUERY_NEW = 0x10;
export const UPDATEDPS = 0x12;
export const HEART_BEAT = 9;
export const LAN_EXT_STREAM = 0x40;
export const SESS_KEY_NEG_START = 3;
export const SESS_KEY_NEG_RESP = 4;
export const SESS_KEY_NEG_FINISH = 5;

const NO_PROTOCOL_HEADER_CMDS = new Set<number>([
  DP_QUERY, DP_QUERY_NEW, UPDATEDPS, HEART_BEAT,
  SESS_KEY_NEG_START, SESS_KEY_NEG_RESP, SESS_KEY_NEG_FINISH,
  LAN_EXT_STREAM,
]);

const PREFIX_55AA = 0x000055aa;
const SUFFIX_55AA = 0x0000aa55;
const PREFIX_BIN = Buffer.from([0x00, 0x00, 0x55, 0xaa]);

export const UDP_KEY = crypto.createHash('md5').update('yGAdlopoPVldABfn').digest();

const CRC_TABLE: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function aesEcbEncrypt(key: Buffer, plaintext: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', key, null);
  cipher.setAutoPadding(true);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function aesEcbDecrypt(key: Buffer, ciphertext: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', key, null);
  decipher.setAutoPadding(true);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function versionHeader(version: string | number): Buffer {
  return Buffer.concat([Buffer.from(String(version), 'latin1'), Buffer.alloc(12, 0)]);
}

export function packMessage(seqno: number, cmd: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(PREFIX_55AA, 0);
  header.writeUInt32BE(seqno >>> 0, 4);
  header.writeUInt32BE(cmd >>> 0, 8);
  header.writeUInt32BE((payload.length + 8) >>> 0, 12);
  const withoutCrc = Buffer.concat([header, payload]);
  const tail = Buffer.alloc(8);
  tail.writeUInt32BE(crc32(withoutCrc), 0);
  tail.writeUInt32BE(SUFFIX_55AA, 4);
  return Buffer.concat([withoutCrc, tail]);
}

export interface TuyaFrame {
  seqno: number;
  cmd: number;
  retcode: number;
  payload: Buffer;
  crcGood: boolean;
}

export function unpackMessage(data: Buffer): TuyaFrame {
  if (data.length < 24) throw new Error('frame too short');
  if (data.readUInt32BE(0) !== PREFIX_55AA) throw new Error('bad prefix, not a 55AA frame');
  const seqno = data.readUInt32BE(4);
  const cmd = data.readUInt32BE(8);
  const length = data.readUInt32BE(12);
  const total = 16 + length;
  if (data.length < total) throw new Error('incomplete frame');
  const retcode = data.readUInt32BE(16);
  const payload = Buffer.from(data.subarray(20, total - 8));
  const crc = data.readUInt32BE(total - 8);
  if (data.readUInt32BE(total - 4) !== SUFFIX_55AA) throw new Error('bad suffix');
  return { seqno, cmd, retcode, payload, crcGood: crc32(data.subarray(0, total - 8)) === crc };
}

function readFrame(sock: net.Socket, timeoutMs: number): Promise<TuyaFrame> {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('timeout waiting for device response'));
    }, timeoutMs);
    function cleanup(): void {
      clearTimeout(timer);
      sock.removeListener('data', onData);
      sock.removeListener('error', onError);
      sock.removeListener('close', onClose);
    }
    function onError(e: Error): void { cleanup(); reject(e); }
    function onClose(): void { cleanup(); reject(new Error('connection closed')); }
    function onData(chunk: Buffer): void {
      buf = Buffer.concat([buf, chunk]);
      const off = buf.indexOf(PREFIX_BIN);
      if (off < 0) {
        if (buf.length > 3) buf = buf.subarray(buf.length - 3);
        return;
      }
      if (off > 0) buf = buf.subarray(off);
      if (buf.length < 16) return;
      const length = buf.readUInt32BE(12);
      if (length > 64 * 1024) { cleanup(); reject(new Error('frame length insane')); return; }
      const total = 16 + length;
      if (buf.length < total) return;
      try {
        const msg = unpackMessage(buf.subarray(0, total));
        cleanup();
        resolve(msg);
      } catch (e) {
        cleanup();
        reject(e);
      }
    }
    sock.on('data', onData);
    sock.once('error', onError);
    sock.once('close', onClose);
  });
}

export function decryptUdp(msg: Buffer): string {
  if (msg.length >= 4 && msg.readUInt32BE(0) === PREFIX_55AA) {
    const inner = unpackMessage(msg).payload;
    if (inner[0] === 0x7b) return inner.toString('utf8');
    return aesEcbDecrypt(UDP_KEY, inner).toString('utf8');
  }
  return aesEcbDecrypt(UDP_KEY, msg).toString('utf8');
}

export interface DeviceOptions {
  id: string;
  ip: string;
  key: string;
  version?: string | number;
  timeout?: number;
}

export class TuyaDevice {
  id: string;
  ip: string;
  version: number;
  key: Buffer;
  timeout: number;
  seqno = 1;
  devType = 'default';

  constructor(opts: DeviceOptions) {
    if (!opts.id) throw new Error('device id required');
    if (!opts.ip) throw new Error('device ip required');
    this.id = opts.id;
    this.ip = opts.ip;
    this.version = parseFloat(String(opts.version ?? 3.3));
    this.key = Buffer.from(opts.key || '', 'latin1');
    if (this.version > 3.1 && this.key.length !== 16) {
      throw new Error('local key must be 16 chars for protocol v3.2+');
    }
    this.timeout = opts.timeout ?? 5000;
  }

  encode(cmd: number, jsonObj: unknown): Buffer {
    const raw = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    let payload: Buffer;
    if (this.version >= 3.2) {
      const enc = aesEcbEncrypt(this.key, raw);
      payload = NO_PROTOCOL_HEADER_CMDS.has(cmd)
        ? enc
        : Buffer.concat([versionHeader(this.version), enc]);
    } else if (cmd === CONTROL) {
      const b64 = aesEcbEncrypt(this.key, raw).toString('base64');
      const pre = Buffer.concat([
        Buffer.from('data='), Buffer.from(b64),
        Buffer.from('||lpv=3.1||'), this.key,
      ]);
      const md5hex = crypto.createHash('md5').update(pre).digest('hex').slice(8, 24);
      payload = Buffer.concat([Buffer.from('3.1' + md5hex), Buffer.from(b64)]);
    } else {
      payload = raw;
    }
    const frame = packMessage(this.seqno++, cmd, payload);
    return frame;
  }

  decode(encryptedPayload: Buffer): Record<string, unknown> {
    let payload = encryptedPayload;
    const header = versionHeader(this.version);
    if (payload.subarray(0, 3).toString() === '3.1' && this.version === 3.1) {
      payload = aesEcbDecrypt(this.key, Buffer.from(payload.subarray(19).toString(), 'base64'));
    } else if (this.version >= 3.2) {
      if (payload.subarray(0, header.length).equals(header)) {
        payload = payload.subarray(header.length);
      } else if (/^3\.[234]/.test(payload.subarray(0, 3).toString())) {
        payload = payload.subarray(15);
      }
      payload = aesEcbDecrypt(this.key, payload);
    }
    const text = payload.toString('utf8');
    if (text.includes('data unvalid')) {
      this.devType = 'device22';
      const err = new Error('device wants device22 mode ("data unvalid")') as Error & { code?: string };
      err.code = 'DEVICE22';
      throw err;
    }
    return JSON.parse(text) as Record<string, unknown>;
  }

  private queryPayload(): { cmd: number; obj: unknown } {
    const t = String(Math.floor(Date.now() / 1000));
    if (this.devType === 'device22') {
      return { cmd: CONTROL_NEW, obj: { devId: this.id, uid: '', t } };
    }
    return { cmd: DP_QUERY, obj: { gwId: this.id, devId: this.id, uid: '', t } };
  }

  async exchange(cmd: number, obj: unknown, retries = 1): Promise<Record<string, unknown>> {
    let lastErr: unknown = new Error('no attempt made');
    for (let attempt = 0; attempt <= retries; attempt++) {
      const sock = net.connect({ host: this.ip, port: 6668 });
      sock.setTimeout(this.timeout);
      try {
        await new Promise<void>((res, rej) => {
          sock.once('connect', () => res());
          sock.once('error', rej);
        });
        sock.write(this.encode(cmd, obj));
        for (let i = 0; i < 3; i++) {
          const msg = await readFrame(sock, this.timeout);
          if (msg.payload.length === 0) continue;
          try {
            return this.decode(msg.payload);
          } catch (e) {
            if ((e as { code?: string }).code === 'DEVICE22' && this.devType === 'device22') {
              sock.destroy();
              const q = this.queryPayload();
              return await this.exchange(q.cmd, q.obj, 0);
            }
            throw e;
          }
        }
        throw new Error('empty response from device');
      } catch (e) {
        lastErr = e;
      } finally {
        sock.destroy();
      }
    }
    throw lastErr;
  }

  status(): Promise<Record<string, unknown>> {
    const q = this.queryPayload();
    return this.exchange(q.cmd, q.obj);
  }

  setDps(dps: Record<string, unknown>): Promise<Record<string, unknown>> {
    const t = String(Math.floor(Date.now() / 1000));
    return this.exchange(CONTROL, { devId: this.id, uid: '', t, dps });
  }
}

export async function detectSwitchDp(device: TuyaDevice): Promise<{ dp: string; status: Record<string, unknown> | null }> {
  try {
    const st = await device.status();
    const dps = ((st?.dps ?? (st?.data as Record<string, unknown> | undefined)?.dps) ?? {}) as Record<string, unknown>;
    if ('20' in dps) return { dp: '20', status: st };
    if ('1' in dps) return { dp: '1', status: st };
  } catch {
    // fall through (e.g. key wrong but TCP open)
  }
  return { dp: '20', status: null };
}

export async function setOn(device: TuyaDevice, on: boolean, dpHint?: string): Promise<Record<string, unknown>> {
  const dp = dpHint ?? (await detectSwitchDp(device)).dp;
  return device.setDps({ [dp]: on });
}

export interface ScannedDevice {
  ip: string;
  gwId: string;
  version: string;
  productKey: string;
  encrypt: unknown;
  extra: Record<string, unknown>;
}

export function scan(timeoutSec = 10, onDevice?: (d: ScannedDevice) => void): Promise<ScannedDevice[]> {
  const found = new Map<string, ScannedDevice>();
  const sockets: dgram.Socket[] = [];
  const ports = [6666, 6667, 7000];
  return new Promise((resolve) => {
    let done = false;
    function emit(info: ScannedDevice): void {
      const key = info.ip + '/' + info.gwId;
      if (!found.has(key)) {
        found.set(key, info);
        onDevice?.(info);
      }
    }
    function finish(): void {
      if (done) return;
      done = true;
      for (const s of sockets) { try { s.close(); } catch { /* noop */ } }
      resolve([...found.values()]);
    }
    for (const port of ports) {
      const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(s);
      s.on('message', (msg: Buffer, rinfo: dgram.RemoteInfo) => {
        try {
          const text = port === 6666 && msg[0] === 0x7b ? msg.toString('utf8') : decryptUdp(msg);
          const data = JSON.parse(text) as Record<string, string | number | boolean>;
          emit({
            ip: String(data.ip ?? rinfo.address),
            gwId: String(data.gwId ?? data.gwid ?? data.devId ?? ''),
            version: String(data.version ?? data.ver ?? ''),
            productKey: String(data.productKey ?? data.product_key ?? ''),
            encrypt: data.encrypt ?? '',
            extra: data as Record<string, unknown>,
          });
        } catch {
          // ignore undecryptable / non-tuya chatter
        }
      });
      s.bind(port);
    }
    setTimeout(finish, timeoutSec * 1000);
  });
}
