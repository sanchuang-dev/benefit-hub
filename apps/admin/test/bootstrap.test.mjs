import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
test('bootstrap is explicitly non-operational', () => {
  const content = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(content, /供应商发券、管理登录和业务订单尚未启用/);
});
