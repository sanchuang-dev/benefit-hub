// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from './App';

afterEach(() => cleanup());

describe('admin bootstrap screen', () => {
  it('renders the actual non-operational UI notice', () => {
    render(<App />);
    expect(screen.getByText('系统基础服务已启动')).toBeTruthy();
    expect(
      screen.getByText(/供应商发券、管理登录和业务订单尚未启用/),
    ).toBeTruthy();
  });

  it('does not show a working fulfillment or sign-in action', () => {
    render(<App />);
    expect(screen.queryByRole('button', { name: /发放|登录/ })).toBeNull();
  });
});
