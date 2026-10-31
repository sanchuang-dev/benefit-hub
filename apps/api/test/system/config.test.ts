import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';

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

describe('A live-write authorization gate', () => {
  it('is disabled by default and enabled only by the exact true value', () => {
    expect(loadConfig({ ...BASE_ENV }).aLiveWritesEnabled).toBe(false);
    expect(
      loadConfig({ ...BASE_ENV, BENEFIT_A_LIVE_WRITE_ENABLED: 'false' })
        .aLiveWritesEnabled,
    ).toBe(false);
    expect(
      loadConfig({ ...BASE_ENV, BENEFIT_A_LIVE_WRITE_ENABLED: 'true' })
        .aLiveWritesEnabled,
    ).toBe(true);
  });

  it('rejects malformed gate values instead of enabling them loosely', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, BENEFIT_A_LIVE_WRITE_ENABLED: 'TRUE' }),
    ).toThrowError(/BENEFIT_A_LIVE_WRITE_ENABLED/);
  });
});

describe('D live-write authorization gate', () => {
  it('is disabled by default and enabled only by the exact true value', () => {
    expect(loadConfig({ ...BASE_ENV }).dLiveWritesEnabled).toBe(false);
    expect(
      loadConfig({ ...BASE_ENV, BENEFIT_D_LIVE_WRITE_ENABLED: 'false' })
        .dLiveWritesEnabled,
    ).toBe(false);
    expect(
      loadConfig({ ...BASE_ENV, BENEFIT_D_LIVE_WRITE_ENABLED: 'true' })
        .dLiveWritesEnabled,
    ).toBe(true);
  });

  it('rejects malformed gate values instead of enabling them loosely', () => {
    expect(() =>
      loadConfig({ ...BASE_ENV, BENEFIT_D_LIVE_WRITE_ENABLED: 'TRUE' }),
    ).toThrowError(/BENEFIT_D_LIVE_WRITE_ENABLED/);
  });
});

describe('server-only downstream order service credentials', () => {
  const TOKEN_A = 'fictional-config-token-local-life-000000001';
  const TOKEN_B = 'fictional-config-token-card-doctor-0000002';

  function load(entries: unknown) {
    return loadConfig({
      ...BASE_ENV,
      BENEFIT_ORDER_CLIENTS_JSON:
        typeof entries === 'string' ? entries : JSON.stringify(entries),
    });
  }

  it('is unavailable when absent or blank', () => {
    expect(loadConfig({ ...BASE_ENV }).businessOrderClients).toBeNull();
    expect(
      loadConfig({ ...BASE_ENV, BENEFIT_ORDER_CLIENTS_JSON: '   ' }).businessOrderClients,
    ).toBeNull();
  });

  it('normalizes source keys and keeps only token digests in memory', () => {
    const config = load({ ' Local-Life ': TOKEN_A, 'card-doctor': TOKEN_B });
    expect(config.businessOrderClients?.clients.map((client) => client.businessSource)).toEqual([
      'local-life',
      'card-doctor',
    ]);
    for (const client of config.businessOrderClients?.clients ?? []) {
      expect(client.tokenSha256).toHaveLength(32);
      expect(JSON.stringify(client)).not.toContain(TOKEN_A);
      expect(JSON.stringify(client)).not.toContain(TOKEN_B);
    }
  });

  it('fails closed on malformed JSON or a non-object map', () => {
    expect(() => load('{"local-life":')).toThrowError(/BENEFIT_ORDER_CLIENTS_JSON/);
    expect(() => load([])).toThrowError(/JSON 对象/);
    expect(() => load(null)).toThrowError(/JSON 对象/);
  });

  it('rejects an empty map instead of silently enabling an empty allow-list', () => {
    expect(() => load({})).toThrowError(/至少需要配置一个业务来源/);
  });

  it('rejects invalid, short, non-string and duplicate tokens without echoing them', () => {
    const shortToken = 'too-short';
    const cases: Array<unknown> = [
      { 'local-life': shortToken },
      { 'local-life': 12345 },
      { 'local-life': `${TOKEN_A} extra` },
      { 'local-life': TOKEN_A, 'card-doctor': TOKEN_A },
      { 'local-life': TOKEN_A, 'LOCAL-LIFE': TOKEN_B },
      { 'Local Life': TOKEN_A },
      { 'local-life': TOKEN_A, '': TOKEN_B },
    ];

    for (const value of cases) {
      let thrown: Error | undefined;
      try {
        load(value);
      } catch (error) {
        thrown = error as Error;
      }
      expect(thrown, JSON.stringify(value)).toBeDefined();
      expect(thrown?.message).toMatch(/BENEFIT_ORDER_CLIENTS_JSON/);
      expect(thrown?.message).not.toContain(TOKEN_A);
      expect(thrown?.message).not.toContain(TOKEN_B);
      expect(thrown?.message).not.toContain(shortToken);
    }
  });
});
