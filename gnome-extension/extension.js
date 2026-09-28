// Quick Settings toggle for the Tuya lamp. Talks to the tuya-manager
// dashboard over localhost HTTP (see ../src/server.ts API).
// Popover wiring mirrors ../gnome-tuya: a QuickToggle living in a
// SystemIndicator's quickSettingsItems.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Soup from 'gi://Soup';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

// Custom bulb in the Adwaita symbolic outline style. install.sh places it in
// ~/.local/share/icons/hicolor/... (with index.theme + icon cache refresh)
// so the themed lookup resolves and St recolors the -symbolic svg like the
// stock toggles — including dark style. NOTE: do not import Gtk here (the
// Shell already loads Gtk 4, so requesting Gtk 3 aborts loading) and do not
// set a FileIcon gicon (it bypasses symbolic recoloring and breaks dark
// style); plain iconName is the correct mechanism.
const ICON_NAME = 'tuya-led-bulb-symbolic';

function dpsIsOn(status) {
    const dps = status?.dps ?? status?.data?.dps ?? {};
    if ('20' in dps)
        return !!dps['20'];
    if ('1' in dps)
        return !!dps['1'];
    return null;
}

const TuyaLedToggle = GObject.registerClass(
class TuyaLedToggle extends QuickToggle {
    _init(settings) {
        super._init({
            title: _('LED'),
            subtitle: _('Tuya lamp'),
            iconName: ICON_NAME,
            toggleMode: true,
        });

        this._settings = settings;
        this._session = new Soup.Session({timeout: 8});
        this._syncing = false;
        this._qs = Main.panel.statusArea.quickSettings;

        this.connect('clicked', () => this._onClicked());
        this._menuOpenId = this._qs.menu.connect('open-state-changed',
            (_menu, open) => {
                if (open)
                    this._syncState();
            });
    }

    destroy() {
        if (this._menuOpenId) {
            this._qs.menu.disconnect(this._menuOpenId);
            this._menuOpenId = 0;
        }
        this._session?.abort();
        super.destroy();
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
        this.subtitle = on ? _('On') : _('Off');
        this._syncing = false;
        this._indicator?.queue_redraw?.();
        if (this._indicator)
            this._indicator.visible = on;
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
        this.subtitle = want ? _('On') : _('Off');
        if (this._indicator)
            this._indicator.visible = want;
        try {
            const id = await this._resolveDeviceId();
            await this._request(`/api/devices/${encodeURIComponent(id)}/${want ? 'on' : 'off'}`, 'POST', {});
        } catch (e) {
            this._setCheckedSilently(!want);
            Main.notify(_('Tuya LED'), `${e.message}`);
        }
    }
});

const TuyaLedIndicator = GObject.registerClass(
class TuyaLedIndicator extends SystemIndicator {
    _init(settings) {
        super._init();
        this._settings = settings;

        this._indicator = this._addIndicator();
        this._indicator.iconName = ICON_NAME;
        this._indicator.visible = false;

        this._toggle = new TuyaLedToggle(settings);
        this._toggle._indicator = this._indicator;
        this.quickSettingsItems.push(this._toggle);
    }

    destroy() {
        this._toggle?.destroy();
        this._toggle = null;
        super.destroy();
    }
});

export default class TuyaLedExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._indicator = new TuyaLedIndicator(this._settings);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        this._settings = null;
    }
}
