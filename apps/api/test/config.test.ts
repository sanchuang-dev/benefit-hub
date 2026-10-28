import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const BASE_ENV = { DATABASE_FILE: ':memory:' };

describe('server-only Yangmao D configuration', () => {
  it('leaves the supplier reader unconfigured when nothing is provided', () => {
    expect(loadConfig({ ...BASE_ENV }).yangmaoInrice).toBeNull();
  });

  it('does not treat a partial configuration as usable', () => {
    const config = loadConfig({
      ...BASE_ENV,
      YANGMAO_INRICE_BASE_URL: 'https://vendor.invalid',
      YANGMAO_INRICE_APP_KEY: 'fixture-key',
    });

    expect(config.yangmaoInrice).toBeNull();
  });

  it('does not treat blank values as configured', () => {
    const config = loadConfig({
      ...BASE_ENV,
      YANGMAO_INRICE_BASE_URL: '   ',
      YANGMAO_INRICE_APP_KEY: 'fixture-key',
      YANGMAO_INRICE_APP_SECRET: 'fixture-secret',
    });

    expect(config.yangmaoInrice).toBeNull();
  });

  it('reads a complete configuration without changing the values', () => {
    const config = loadConfig({
      ...BASE_ENV,
      YANGMAO_INRICE_BASE_URL: 'https://vendor.invalid',
      YANGMAO_INRICE_APP_KEY: 'fixture-key',
      YANGMAO_INRICE_APP_SECRET: 'fixture-secret',
    });

    expect(config.yangmaoInrice).toEqual({
      baseUrl: 'https://vendor.invalid',
      appKey: 'fixture-key',
      appSecret: 'fixture-secret',
    });
  });
});
