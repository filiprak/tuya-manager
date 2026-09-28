// Best-effort "turn every known lamp off" helper, meant to run on shutdown.
// Wired up by scripts/install.sh as the ExecStop of the tuya-led-off.service
// user unit (Before=shutdown.target, so LAN is still up when this runs).
//
// Usage: node dist/led-off.js [--device <id>] [--timeout <ms>]
// Env: TUYA_CONFIG (store path), TUYA_DEVICE (limit to one device),
//      LED_TIMEOUT_MS (per-device timeout, default 2500).
//
// Always exits 0: a shutdown hook must never fail the shutdown.

import { TuyaDevice, setOn } from './tuya.js';
import { storePath, loadStore } from './store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const onlyDevice = arg('--device') || process.env.TUYA_DEVICE || undefined;
const timeoutMs = Math.min(
  Math.max(parseInt(arg('--timeout') || process.env.LED_TIMEOUT_MS || '2500', 10) || 2500, 500),
  15000,
);

const store = loadStore(storePath());
const candidates = Object.values(store.devices).filter((d) => d.key);
const targets = onlyDevice ? candidates.filter((d) => d.id === onlyDevice) : candidates;

if (onlyDevice && targets.length === 0) {
  console.error(`led-off: device ${onlyDevice} not in store (or has no local key); nothing to do`);
  process.exit(0);
}
if (targets.length === 0) {
  console.log('led-off: no devices with local keys; nothing to do');
  process.exit(0);
}

const results = await Promise.allSettled(
  targets.map(async (cached) => {
    const dev = new TuyaDevice({
      id: cached.id,
      ip: cached.ip,
      key: cached.key,
      version: cached.version,
      timeout: timeoutMs,
    });
    await setOn(dev, false);
    return cached.id;
  }),
);

let failed = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const id = targets[i].id;
  if (r.status === 'fulfilled') {
    console.log(`led-off: ${id} off`);
  } else {
    failed++;
    console.error(`led-off: ${id} failed: ${(r.reason as Error)?.message || r.reason}`);
  }
}
if (failed > 0) console.error(`led-off: ${failed}/${targets.length} failed (best effort)`);
process.exit(0);
