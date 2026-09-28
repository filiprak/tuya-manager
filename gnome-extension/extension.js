// Quick Settings toggle for the Tuya lamp. Talks to the tuya-manager
// dashboard over localhost HTTP (see ../src/server.ts API).

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

function dpsIsOn(status) {
    const dps = status?.dps ?? status?.data?.dps ?? {};
    if ('20' in dps)
        return !!dps['20'];
    if ('1' in dps)
        return !!dps['1'];
    return null;
}

const TuyaLedToggle = GObject.registerClass(
class TuyaLedToggle extends QuickSettings.QuickToggle {
    _init(ext) {
        super._init({
            title: _('LED'),
            iconName: 'lightbulb-symbolic',
            toggleMode: true,
        });

        this._ext = ext;
        this._settings = ext.getSettings();
        this._session = new Soup.Session({timeout: 8});
        this._syncing = false;
        this._qs = Main.panel.statusArea.quickSettings;

        this.menu.setHeader('lightbulb-symbolic', _('LED'), _('Tuya lamp'));
        this.connect('clicked', () => this._onClicked());
        this._menuOpenId = this._qs.menu.connect('open-state-changed',
            (_menu, open) => {
                if (open)
                    this._syncState();
            });
    }

    cleanup() {
        if (this._menuOpenId) {
            this._qs.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        this._session?.abort();
    }

    _apiBase() {
        return this._settings.get_string('api-base').replace(/\/+$/, '');
    }

    _request(path, method = 'GET', body = null) {
        const msg = Soup.Message.new(method, `${this._apiBase()}${path}`);
        if (body !== null)
            msg.set_request_body_from_bytes('application/json', GLib.Bytes.new(JSON.stringify(body)));
        return new Promise((resolve, reject) => {
            this._session.send_and_read_async(msg, GLib.PRIORITY_DEFAULT, null, (session, result) => {
                let text = '';
                try {
                    const bytes = session.send_and_read_finish(result);
                    text = new TextDecoder().decode(bytes.get_data() ?? new Uint8Array());
                } catch (e) {
                    reject(new Error(`request failed: ${e.message}`));
                    return;
                }
                if (msg.get_status() !== Soup.Status.OK) {
                    let err = text || `HTTP ${msg.get_status()}`;
                    try {
                        err = JSON.parse(text).error || err;
                    } catch {
                        // keep raw text
                    }
                    reject(new Error(String(err)));
                    return;
                }
                try {
                    resolve(text ? JSON.parse(text) : {});
                } catch (e) {
                    reject(new Error(`bad JSON: ${e.message}`));
                }
            });
        });
    }

    async _resolveDeviceId() {
        const configured = this._settings.get_string('device-id').trim();
        if (configured)
            return configured;
        const {default: def, devices} = await this._request('/api/devices');
        const pick = (devices ?? []).find(d => d.id === def) ?? (devices ?? [])[0];
        if (!pick)
            throw new Error('no devices cached — open the dashboard and scan');
        if (!pick.key || pick.key === 'missing')
            throw new Error('no local key — save it in the dashboard first');
        return pick.id;
    }

    _setCheckedSilently(on) {
        this._syncing = true;
        this.checked = on;
        this._syncing = false;
    }

    async _syncState() {
        try {
            const id = await this._resolveDeviceId();
            const {status} = await this._request(`/api/devices/${encodeURIComponent(id)}/status`);
            const on = dpsIsOn(status);
            if (on !== null)
                this._setCheckedSilently(on);
        } catch {
            // leave the toggle as-is when offline; click will surface the error
        }
    }

    async _onClicked() {
        if (this._syncing)
            return;
        const want = this.checked;
        try {
            const id = await this._resolveDeviceId();
            await this._request(`/api/devices/${encodeURIComponent(id)}/${want ? 'on' : 'off'}`, 'POST', {});
        } catch (e) {
            this._setCheckedSilently(!want);
            Main.notify(_('Tuya LED'), `${e.message}`);
        }
    }
});

export default class TuyaLedExtension extends Extension {
    enable() {
        this._toggle = new TuyaLedToggle(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._toggle);
    }

    disable() {
        this._toggle?.cleanup();
        this._toggle?.destroy();
        this._toggle = null;
    }
}
