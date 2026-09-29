# tuya-manager

Node.js web + GNOME app to integrate with Tuya LED devices over LAN.

## Setup

1. Start the server and open the dashboard.
2. Press **Scan** — discovered devices (address, device ID, protocol version)
   are cached in `devices.json`.
3. Paste each device's **local key** once in the dashboard;
   afterwards on/off/toggle/status work keyless.

> Control needs the per-device **local key**.
> Enter it once in the dashboard — it is stored server-side in `devices.json` (0600, gitignored).

## Run

```bash
pnpm install
pnpm build
pnpm start            # dashboard at http://localhost:9751
PORT=8080 pnpm start  # custom port
```

## GNOME toggle + background service

`scripts/install.sh` builds the server, runs it constantly as a systemd user
service, and installs a Quick Settings toggle (next to Wi-Fi/Bluetooth) that
turns the lamp on/off on click (state re-syncs each time the menu opens).
Settings (API URL, pinned device ID) live in Extension Manager preferences.

```bash
PORT=9751 ./scripts/install.sh
./scripts/uninstall.sh   # stops service, removes extension, keeps devices.json
```

Layout: `gnome-extension/` (`extension.js`, `prefs.js`, `metadata.json`,
`schemas/`), user unit `tuya-manager.service` plus shutdown hook
`tuya-led-off.service` (runs `node dist/led-off.js` on shutdown so the lamp
turns itself off) and boot hook `tuya-led-on.service`
(runs `node dist/led-on.js` after login so the lamp turns itself on;
retries for ~30s while Wi-Fi comes up). Re-run `scripts/install.sh`
to install them.

Manual test: `node dist/led-off.js` (all devices) or
`node dist/led-off.js --device <id>`; same flags for `node dist/led-on.js`
(plus `--retries <n> --retry-delay <ms>`); always exits 0.

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

## Protocol notes

* Frame: `55AA seq cmd len payload CRC32 footer` (`src/tuya.ts:packMessage`).
* v3.3 crypto: AES-128-ECB of JSON with static local key, clear `3.3 + 12×0x00`
  header except for `DP_QUERY` etc. (`TuyaDevice.encode`).
* `DP_QUERY` (0x0A): `{"gwId","devId","uid":"","t":epoch}`;
  `CONTROL` (0x07): `{"devId","uid":"","t":epoch,"dps":{...}}`.
* Bulb on/off: Type B → DP `20`, Type A/C → DP `1`; auto-detected from
  `status().dps` (`detectSwitchDp`).
* Scan: UDP 6666 (plaintext) / 6667 (AES-ECB, `md5("yGAdlopoPVldABfn")`) / 7000.

## Layout

* `src/tuya.ts` — protocol, `TuyaDevice`, `scan`
* `src/store.ts` — `devices.json` cache (migrates legacy `.tuya.json`)
* `src/server.ts` — `node:http` API + static files (zero runtime deps)
* `public/index.html` — Tailwind dashboard (CDN, no build step)
* `gnome-extension/` — Quick Settings LED toggle (shell 45–50, stock
  `utilities-terminal-symbolic` icon like `../gnome-tuya`)
* `scripts/install.sh` / `scripts/uninstall.sh` — service + extension setup
