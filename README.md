# tuya-manager

TypeScript HTTP server + Tailwind dashboard for Tuya LAN devices.
Tuya protocol ported from [`tinytuya`](../../tinytuya) (`core/crypto_helper.py`,
`core/message_helper.py`, `core/XenonDevice.py`, `BulbDevice.py`, `scanner.py`).

## Setup

1. Start the server and open the dashboard.
2. Press **Scan** — discovered devices (address, device ID, protocol version)
   are cached in `devices.json`.
3. Paste each device's **local key** once in the dashboard
   (get it via `tinytuya wizard`); afterwards on/off/toggle/status work keyless.

> Control needs the per-device **local key** (`tinytuya wizard`).
> Enter it once in the dashboard — it is stored server-side in `devices.json` (0600, gitignored).

## Run

```bash
pnpm install
pnpm build
pnpm start            # dashboard at http://localhost:3000
PORT=8080 pnpm start  # custom port
```

## REST API

| method | path | description |
|---|---|---|
| GET | `/api/devices` | cached devices (keys masked) |
| POST | `/api/scan` `{timeoutSec?}` | scan LAN, merge into `devices.json` |
| GET | `/api/devices/:id/status` | live DPS report |
| POST | `/api/devices/:id/on` `{dp?}` | switch on (DP auto-detect: 20 vs 1) |
| POST | `/api/devices/:id/off` `{dp?}` | switch off |
| POST | `/api/devices/:id/toggle` | flip current switch state |
| POST | `/api/devices/:id/color` `{r,g,b}` or `{hex:"#rrggbb"}` | set LED color (DP auto-detect: 5/A vs 24/B) |
| POST | `/api/devices/:id/dps` `{dps}` | set arbitrary datapoints |
| PUT | `/api/devices/:id` `{key?, ip?, version?}` | store key / fix address |

## Protocol notes (from tinytuya `PROTOCOL.md`)

* Frame: `55AA seq cmd len payload CRC32 footer` (`src/tuya.ts:packMessage`).
* v3.3 crypto: AES-128-ECB of JSON with static local key, clear `3.3 + 12×0x00`
  header except for `DP_QUERY` etc. (`TuyaDevice.encode`).
* `DP_QUERY` (0x0A): `{"gwId","devId","uid":"","t":epoch}`;
  `CONTROL` (0x07): `{"devId","uid":"","t":epoch,"dps":{...}}`.
* Bulb on/off: Type B → DP `20`, Type A/C → DP `1`; auto-detected from
  `status().dps` like `BulbDevice.detect_bulb` (`detectSwitchDp`).
* Scan: UDP 6666 (plaintext) / 6667 (AES-ECB, `md5("yGAdlopoPVldABfn")`) / 7000.

## Layout

* `src/tuya.ts` — protocol, `TuyaDevice`, `scan`
* `src/store.ts` — `devices.json` cache (migrates legacy `.tuya.json`)
* `src/server.ts` — `node:http` API + static files (zero runtime deps)
* `public/index.html` — Tailwind dashboard (CDN, no build step)
