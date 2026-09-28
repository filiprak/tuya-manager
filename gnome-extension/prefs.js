// Preferences for the Tuya LED extension (API URL + optional device ID).

import Adw from 'gi://Adw';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class TuyaLedPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({title: _('Connection')});

        const apiRow = new Adw.EntryRow({title: _('API base URL')});
        apiRow.set_text(settings.get_string('api-base'));
        apiRow.connect('changed', () => settings.set_string('api-base', apiRow.get_text()));

        const devRow = new Adw.EntryRow({title: _('Device ID (blank = dashboard default)')});
        devRow.set_text(settings.get_string('device-id'));
        devRow.connect('changed', () => settings.set_string('device-id', devRow.get_text()));

        group.add(apiRow);
        group.add(devRow);
        page.add(group);
        window.add(page);
    }
}
