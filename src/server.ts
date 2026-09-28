// Tiny HTTP dashboard for Tuya LAN devices. Zero runtime deps (node:http only).
//
//   GET  /api/devices              cached devices (keys masked)
//   POST /api/scan {timeoutSec?}   scan LAN, merge into devices.json
//   GET  /api/devices/:id/status
//   POST /api/devices/:id/on|off|toggle {dp?}
//   POST /api/devices/:id/dps {dps}
//   PUT  /api/devices/:id {key?, ip?, version?}
//   GET  /                        dashboard UI

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TuyaDevice, detectSwitchDp, setOn, scan } from './tuya.js';
import { storePath, loadStore, saveStore, mergeScanResults, getDevice } from './store.js';

const PORT = parseInt(process.env.PORT || '3000', 10);
const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STORE_FILE = storePath();

function maskKey(dev: { key?: string }): string {
  return dev.key ? 'set' : 'missing';
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let text = '';
    req.on('data', (c: Buffer) => {
      text += c.toString('utf8');
      if (text.length > 64 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!text) { resolve({}); return; }
      try {
        resolve(JSON.parse(text) as Record<string, unknown>);
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): boolean {
  const urlPath = (req.url || '/').split('?')[0];
  if (urlPath.startsWith('/api/')) return false;
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return false;
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
  return true;
}

function deviceOr404(store: ReturnType<typeof loadStore>, id: string, res: http.ServerResponse) {
  const cached = getDevice(store, id);
  if (!cached) {
    json(res, 404, { error: `unknown device ${id}` });
    return null;
  }
  if (!cached.key) {
    json(res, 400, { error: `no local key for ${id}; set it via PUT /api/devices/${id}` });
    return null;
  }
  return cached;
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const method = req.method || 'GET';
  const url = new URL(req.url || '/', 'http://localhost');
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'devices', ...]

  // GET /api/devices
  if (method === 'GET' && parts.length === 2 && parts[1] === 'devices') {
    const store = loadStore(STORE_FILE);
    json(res, 200, {
      default: store.default,
      devices: Object.values(store.devices).map((d) => ({ ...d, key: maskKey(d) })),
    });
    return;
  }

  // POST /api/scan
  if (method === 'POST' && parts.length === 2 && parts[1] === 'scan') {
    const body = await readBody(req);
    const timeoutSec = Math.min(Math.max(Number(body.timeoutSec ?? 10) || 10, 1), 60);
    const found = await scan(timeoutSec);
    const store = loadStore(STORE_FILE);
    mergeScanResults(store, found);
    saveStore(store, STORE_FILE);
    json(res, 200, { found, cached: Object.keys(store.devices).length });
    return;
  }

  if (parts.length >= 3 && parts[1] === 'devices') {
    const id = decodeURIComponent(parts[2]);
    const store = loadStore(STORE_FILE);

    // PUT /api/devices/:id {key?, ip?, version?}
    if (method === 'PUT' && parts.length === 3) {
      const body = await readBody(req);
      const cached = getDevice(store, id);
      if (!cached) { json(res, 404, { error: `unknown device ${id}; scan first` }); return; }
      if (typeof body.key === 'string') cached.key = body.key;
      if (typeof body.ip === 'string' && body.ip) cached.ip = body.ip;
      if (typeof body.version === 'string' && body.version) cached.version = body.version;
      saveStore(store, STORE_FILE);
      json(res, 200, { ...cached, key: maskKey(cached) });
      return;
    }

    const cached = deviceOr404(store, id, res);
    if (!cached) return;
    const dev = new TuyaDevice({ id: cached.id, ip: cached.ip, key: cached.key, version: cached.version });

    // GET /api/devices/:id/status
    if (method === 'GET' && parts.length === 4 && parts[3] === 'status') {
      try {
        json(res, 200, { status: await dev.status() });
      } catch (e) {
        json(res, 502, { error: `status failed: ${(e as Error).message}` });
      }
      return;
    }

    const body = (method === 'POST' && parts.length === 4) ? await readBody(req) : {};

    // POST /api/devices/:id/on|off|toggle
    if (method === 'POST' && parts.length === 4 && ['on', 'off', 'toggle'].includes(parts[3])) {
      try {
        const dp = typeof body.dp === 'string' ? body.dp : undefined;
        let result: unknown;
        if (parts[3] === 'toggle') {
          const { dp: detected, status } = await detectSwitchDp(dev);
          const cur = (status?.dps as Record<string, unknown> | undefined)?.[dp ?? detected];
          result = await setOn(dev, !cur, dp ?? detected);
        } else {
          result = await setOn(dev, parts[3] === 'on', dp);
        }
        json(res, 200, { result });
      } catch (e) {
        json(res, 502, { error: `command failed: ${(e as Error).message}` });
      }
      return;
    }

    // POST /api/devices/:id/dps {dps: {...}}
    if (method === 'POST' && parts.length === 4 && parts[3] === 'dps') {
      if (!body.dps || typeof body.dps !== 'object') {
        json(res, 400, { error: 'body must be {dps: {...}}' });
        return;
      }
      try {
        json(res, 200, { result: await dev.setDps(body.dps as Record<string, unknown>) });
      } catch (e) {
        json(res, 502, { error: `command failed: ${(e as Error).message}` });
      }
      return;
    }
  }

  json(res, 404, { error: 'not found' });
}

const server = http.createServer((req, res) => {
  if (serveStatic(req, res)) return;
  if ((req.url || '').startsWith('/api/')) {
    handleApi(req, res).catch((e: Error) => {
      if (!res.headersSent) json(res, 500, { error: e.message });
    });
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log(`tuya-manager dashboard at http://localhost:${PORT} (store: ${STORE_FILE})`);
});
