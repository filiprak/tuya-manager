// Device cache in devices.json (tinytuya devices.json-style).
// Scan results are merged here so the dashboard survives restarts.

import fs from 'node:fs';
import path from 'node:path';
import type { ScannedDevice } from './tuya.js';

export const STORE_FILE = 'devices.json';
const LEGACY_FILE = '.tuya.json';

export interface CachedDevice {
  id: string;
  ip: string;
  version: string;
  productKey: string | null;
  mac: string | null;
  key: string;
  lastSeen: string;
}

export interface Store {
  default: string | null;
  devices: Record<string, CachedDevice>;
}

function emptyStore(): Store {
  return { default: null, devices: {} };
}

export function storePath(explicit?: string): string {
  if (explicit) return path.resolve(explicit);
  if (process.env.TUYA_CONFIG) return path.resolve(process.env.TUYA_CONFIG);
  return path.resolve(process.cwd(), STORE_FILE);
}

export function loadStore(file = storePath()): Store {
  for (const candidate of [file, path.resolve(path.dirname(file), LEGACY_FILE)]) {
    try {
      const raw = fs.readFileSync(candidate, 'utf8');
      const data = JSON.parse(raw) as Partial<Store>;
      if (!data || typeof data !== 'object') continue;
      return { default: data.default ?? null, devices: data.devices && typeof data.devices === 'object' ? data.devices : {} };
    } catch {
      continue;
    }
  }
  return emptyStore();
}

export function saveStore(store: Store, file = storePath()): string {
  const tmp = `${file}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch { /* noop */ }
  return file;
}

export function mergeScanResults(store: Store, found: ScannedDevice[]): boolean {
  let touched = false;
  for (const d of found) {
    if (!d.gwId) continue;
    const prev = store.devices[d.gwId];
    store.devices[d.gwId] = {
      id: d.gwId,
      ip: d.ip || prev?.ip || '',
      version: d.version || prev?.version || '3.3',
      productKey: d.productKey || prev?.productKey || null,
      mac: (d.extra?.mac as string | undefined) || prev?.mac || null,
      key: prev?.key || '',
      lastSeen: new Date().toISOString(),
    };
    touched = true;
  }
  const ids = Object.keys(store.devices);
  if (ids.length === 1) store.default = ids[0];
  if ((!store.default || !store.devices[store.default]) && ids.length > 0) {
    store.default = found[0]?.gwId || ids[0];
  }
  return touched;
}

export function getDevice(store: Store, id: string): CachedDevice | undefined {
  return store.devices[id];
}
