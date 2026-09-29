// Best-effort "turn every known lamp on" helper, meant to run on login/boot.
// Wired up by scripts/install.sh as tuya-led-on.service user unit
// (After=network-online.target, WantedBy=default.target).
//
// Usage: node dist/led-on.js [--device <id>] [--timeout <ms>]
//        [--retries <n>] [--retry-delay <ms>]
// Env: TUYA_CONFIG (store path), TUYA_DEVICE (limit to one device),
//      LED_TIMEOUT_MS (per-device timeout, default 2500),
//      LED_RETRIES (default 10), LED_RETRY_DELAY_MS (default 3000).
//
// Retries exist because at boot the LAN/Wi-Fi may not be up yet.
// Always exits 0: a boot hook must never fail the boot.

import { TuyaDevice, setOn } from './tuya.js';
import { storePath, loadStore } from './store.js';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const onlyDevice = arg('--device') || process.env.TUYA_DEVICE || undefined;
const timeoutMs = Math.min(
  Math.max(parseInt(arg('--timeout') || process.env.LED_TIMEOUT_MS || '2500', 10) || 2500, 500),
  15000,
);
const retries = Math.min(
  Math.max(parseInt(arg('--retries') || process.env.LED_RETRIES || '10', 10) || 10, 0),
  60,
);
const retryDelayMs = Math.min(
  Math.max(
    parseInt(arg('--retry-delay') || process.env.LED_RETRY_DELAY_MS || '3000', 10) || 3000,
    500,
  ),
  30000,
);

const store = loadStore(storePath());
const candidates = Object.values(store.devices).filter((d) => d.key);
const targets = onlyDevice ? candidates.filter((d) => d.id === onlyDevice) : candidates;

if (onlyDevice && targets.length === 0) {
  console.error(`led-on: device ${onlyDevice} not in store (or has no local key); nothing to do`);
  process.exit(0);
}
if (targets.length === 0) {
  console.log('led-on: no devices with local keys; nothing to do');
  process.exit(0);
}

const results = await Promise.allSettled(
  targets.map(async (cached) => {
    let lastErr: unknown = new Error('no attempt made');
    for (let attempt = 0; attempt <= retries; attempt++) {
      const dev = new TuyaDevice({
        id: cached.id,
        ip: cached.ip,
        key: cached.key,
        version: cached.version,
        timeout: timeoutMs,
      });
      try {
        await setOn(dev, true);
        return cached.id;
      } catch (e) {
        lastErr = e;
        if (attempt < retries) {
          console.error(
            `led-on: ${cached.id} attempt ${attempt + 1}/${retries + 1} failed: ${(e as Error)?.message || e}; retrying in ${retryDelayMs}ms`,
          );
          await sleep(retryDelayMs);
        }
      }
    }
    throw lastErr;
  }),
);

let failed = 0;
for (let i = 0; i < results.length; i++) {
  const r = results[i];
  const id = targets[i].id;
  if (r.status === 'fulfilled') {
    console.log(`led-on: ${id} on`);
  } else {
    failed++;
    console.error(`led-on: ${id} failed: ${(r.reason as Error)?.message || r.reason}`);
  }
}
if (failed > 0) console.error(`led-on: ${failed}/${targets.length} failed (best effort)`);
process.exit(0);
