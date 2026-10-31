import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SETTINGS_PATH,
  legacySettingsTabPath,
  SETTINGS_SECTIONS,
  settingsSectionMeta,
} from './sections';

describe('settings sections', () => {
  it('defines one independent page per governance workspace', () => {
    expect(SETTINGS_SECTIONS.map((section) => [section.key, section.path])).toEqual([
      ['accounts', '/settings/accounts'],
      ['security', '/settings/security'],
      ['audit', '/settings/audit'],
      ['runtime', '/settings/runtime'],
    ]);
  });

  it('resolves section metadata and rejects unknown keys', () => {
    expect(settingsSectionMeta('audit').label).toBe('操作审计');
    expect(settingsSectionMeta('runtime').path).toBe('/settings/runtime');
  });

  it('maps the retired ?tab= deep links onto the new pages', () => {
    expect(legacySettingsTabPath('security')).toBe('/settings/security');
    expect(legacySettingsTabPath('audit')).toBe('/settings/audit');
    expect(legacySettingsTabPath(null)).toBeNull();
    expect(legacySettingsTabPath('nope')).toBeNull();
  });

  it('keeps the default entry on the account workspace', () => {
    expect(DEFAULT_SETTINGS_PATH).toBe('/settings/accounts');
  });
});
