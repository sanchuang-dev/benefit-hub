// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { installDomStubs, resetUiPrefs } from '../../test-utils/render-routes';
import { useUiPrefs } from '../lib/ui-prefs';
import { DataPanel, type PanelColumn, type PanelFilter, type PanelQuery } from './DataPanel';

type Row = { id: string; name: string; price: number };
type Filters = { keyword: string; state: string; price: { min?: number; max?: number } };
type SortKey = 'name' | 'price';
const ROWS: Row[] = [
  { id: 'b', name: 'B 商品', price: 100 },
  { id: 'a', name: 'A 商品', price: 500 },
];
const FILTERS: Filters = { keyword: '', state: 'all', price: {} };
const fields: PanelFilter<Filters>[] = [
  { key: 'keyword', kind: 'text', label: '名称', placeholder: '商品名称' },
  { key: 'state', kind: 'select', label: '状态', options: [
    { label: '全部', value: 'all' }, { label: '已启用', value: 'active' },
  ] },
  { key: 'price', kind: 'numberRange', label: '价格', advanced: true },
];
const columns: PanelColumn<Row, SortKey>[] = [
  { key: 'name', title: '商品', dataIndex: 'name', sortKey: 'name' },
  { key: 'price', title: '价格', dataIndex: 'price', sortKey: 'price' },
];
const changes = vi.fn<(query: PanelQuery<Filters, SortKey>) => void>();
const refreshed = vi.fn();
const selected = vi.fn<(row: Row) => void>();

function Fixture({
  id = 'fixture-a',
  withCards = true,
  error,
  rows = ROWS,
  loading = false,
  readonly = false,
}: {
  id?: string;
  withCards?: boolean;
  error?: Error;
  rows?: Row[];
  loading?: boolean;
  readonly?: boolean;
}) {
  const [query, setQuery] = useState<PanelQuery<Filters, SortKey>>({
    filters: FILTERS, page: 3, pageSize: 20,
  });
  return <DataPanel<Row, Filters, SortKey>
    id={id}
    label="演示数据"
    rowKey={(row) => row.id}
    query={query}
    onQueryChange={(next) => { changes(next); setQuery(next); }}
    initialFilters={FILTERS}
    data={{ rows, total: 45, loading, error }}
    filters={fields}
    columns={columns}
    renderCard={withCards ? (row) => <div>{row.name}</div> : undefined}
    rowActions={readonly ? undefined : (row) => [
      { key: 'view', label: '查看', onClick: selected },
      ...(row.id === 'b' ? [{ key: 'disabled', label: '编辑', disabled: true, onClick: selected }] : []),
    ]}
    onRefresh={refreshed}
  />;
}

beforeAll(() => installDomStubs());
afterEach(() => {
  cleanup();
  resetUiPrefs();
  changes.mockReset();
  refreshed.mockReset();
  selected.mockReset();
});

describe('DataPanel controlled query contract', () => {
  it('submits advanced and basic filters, resets paging and preserves URL-owner responsibility', async () => {
    render(<Fixture />);
    expect(screen.queryByLabelText('价格最小值')).toBeTruthy();
    // The advanced controls stay mounted for form state, but are visually hidden.
    expect(screen.getByLabelText('价格最小值').closest('[hidden]')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '高级检索' }));
    expect(screen.getByLabelText('价格最小值').closest('[hidden]')).toBeNull();
    fireEvent.change(screen.getByLabelText('名称'), { target: { value: '咖啡' } });
    fireEvent.change(screen.getByLabelText('价格最小值'), { target: { value: '100' } });
    fireEvent.click(screen.getByRole('button', { name: /查\s*询/ }));
    await waitFor(() => expect(changes).toHaveBeenCalled());
    expect(changes.mock.lastCall?.[0]).toMatchObject({
      page: 1, pageSize: 20, filters: { keyword: '咖啡', price: { min: 100 } },
    });
    fireEvent.click(screen.getByRole('button', { name: /重\s*置/ }));
    expect(changes.mock.lastCall?.[0]).toEqual({ page: 1, pageSize: 20, filters: FILTERS });
    expect((screen.getByLabelText('名称') as HTMLInputElement).value).toBe('');
    expect((screen.getByLabelText('价格最小值') as HTMLInputElement).value).toBe('');
  });

  it('emits a server sort without reordering current page rows locally', async () => {
    render(<Fixture withCards={false} />);
    const before = screen.getAllByRole('row').slice(1).map((el) => el.textContent);
    fireEvent.click(screen.getByRole('columnheader', { name: /价格/ }));
    await waitFor(() => expect(changes).toHaveBeenCalled());
    expect(changes.mock.lastCall?.[0]).toMatchObject({
      page: 1, sort: { key: 'price', order: 'asc' },
    });
    const after = screen.getAllByRole('row').slice(1).map((el) => el.textContent);
    expect(after).toEqual(before);
  });

  it('uses the same rows for table and card and does not own requests or write actions', () => {
    render(<Fixture />);
    expect(screen.getByText('B 商品')).toBeTruthy();
    fireEvent.click(screen.getByText('卡片'));
    expect(screen.getByRole('list', { name: '数据卡片' })).toBeTruthy();
    expect(screen.getByRole('list', { name: '数据卡片' }).querySelectorAll('[role="listitem"]')).toHaveLength(ROWS.length);
    expect(changes).not.toHaveBeenCalled();
    expect(refreshed).not.toHaveBeenCalled();
    expect(useUiPrefs.getState().dataPanels['fixture-a']?.view).toBe('card');
    fireEvent.click(screen.getAllByRole('button', { name: /查\s*看/ })[0]);
    expect(selected).toHaveBeenCalledWith(ROWS[0]);
  });

  it('isolates column visibility/order/density between panels', async () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: '列设置' }));
    const price = await screen.findByRole('checkbox', { name: '价格' });
    fireEvent.click(price);
    expect(useUiPrefs.getState().dataPanels['fixture-a']?.visibleKeys).toEqual(['name']);
    fireEvent.click(screen.getByRole('button', { name: '上移价格' }));
    expect(useUiPrefs.getState().dataPanels['fixture-a']?.columnOrder).toEqual(['price', 'name']);
    fireEvent.click(screen.getByText('紧凑'));
    expect(useUiPrefs.getState().dataPanels['fixture-a']?.density).toBe('small');
    expect(useUiPrefs.getState().dataPanels['other-panel']).toBeUndefined();
    expect(changes).not.toHaveBeenCalled();
  });

  it('supports a read-only fixture, error/retry and unconfigured card view', () => {
    const { rerender } = render(<Fixture readonly withCards={false} error={new Error('service unavailable')} />);
    expect(screen.getByText('数据加载失败')).toBeTruthy();
    expect(screen.getByText('service unavailable')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /重\s*试/ }));
    expect(refreshed).toHaveBeenCalledTimes(1);
    rerender(<Fixture readonly withCards={false} rows={[]} />);
    expect(screen.getByText('暂无数据')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /查\s*看/ })).toBeNull();
    expect(screen.queryByText('卡片')).toBeNull();
  });

  it('does not claim an empty dataset while the first request is loading', () => {
    render(<Fixture loading rows={[]} withCards={false} />);
    expect(screen.queryByText('暂无数据')).toBeNull();
  });
});
