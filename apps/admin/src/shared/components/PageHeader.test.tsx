// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PageHeader } from './PageHeader';

/**
 * Contract tests for the route-level page head.
 *
 * The bug this guards against is layout drift between pages: each workspace
 * page used to hand-roll its own <header className="page-header">, so the title
 * box, action placement and description line differed per route, and switching
 * a work tab looked like the page jumped. Every page must now render this one
 * component, and it must expose exactly one heading.
 */
afterEach(() => {
  // Without Vitest globals there is no automatic cleanup, and a leftover render
  // would make the "exactly one heading" assertions pass for the wrong reason.
  cleanup();
});

describe('PageHeader', () => {
  it('renders the page title as the single level-2 heading', () => {
    render(<PageHeader title="供应商管理" description="查看供货方、接入配置与供货商品。" />);

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('供应商管理');
    expect(screen.getByText('查看供货方、接入配置与供货商品。')).toBeTruthy();
  });

  it('keeps the header box and title line identical with and without actions', () => {
    const { container: plain } = render(
      <PageHeader title="接口管理" description="生成、预览和发布可调用的接口。" />,
    );
    const plainHeader = plain.querySelector('.page-header');
    expect(plainHeader?.querySelector('.page-header-title')).toBeTruthy();
    // No actions means no second flex child, so the title keeps the full width.
    expect(plainHeader?.querySelector('.page-header-actions')).toBeNull();

    const { container: withActions } = render(
      <PageHeader
        title="业务订单"
        description="查看平台订单、冻结履约来源和状态记录。"
        actions={<span>只读</span>}
      />,
    );
    const actionHeader = withActions.querySelector('.page-header');
    // Actions are header chrome pinned beside the title, never a second row
    // underneath it, because a stacked row would push the body down.
    const actions = actionHeader?.querySelector('.page-header-actions');
    expect(actions).toBeTruthy();
    expect(actionHeader?.querySelector('.page-header-title')?.contains(actions ?? null)).toBe(false);
    expect(screen.getByText('只读')).toBeTruthy();
  });

  it('lets a child page use a breadcrumb as the heading line instead of a duplicate title', () => {
    const { container } = render(
      <PageHeader
        breadcrumb={
          <span role="heading" aria-level={2}>
            上力
          </span>
        }
        description="接入配置、商品目录与供货信息。"
      />,
    );

    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('上力');
    expect(container.querySelector('.page-header-title')).toBeTruthy();
  });

  it('renders status metadata inline with the title instead of adding a prose line', () => {
    const { container } = render(
      <PageHeader
        title="供应商管理"
        description="查看供货方、接入配置与供货商品。"
        status={<span>凭证已配置</span>}
      />,
    );

    const title = container.querySelector('.page-header-title');
    expect(title?.textContent).toContain('供应商管理');
    expect(title?.textContent).toContain('凭证已配置');
  });
});
