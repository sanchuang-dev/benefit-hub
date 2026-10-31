import {
  Alert,
  Button,
  Checkbox,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Pagination,
  Popover,
  Segmented,
  Select,
  Space,
  Spin,
  Table,
} from 'antd';
import type { ColumnType, TableProps } from 'antd/es/table';
import { ArrowDown, ArrowUp, RotateCcw, Search, Settings2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import {
  moveColumn,
  resolvePanelPreference,
  type DataPanelPreference,
  type PanelDensity,
  type PanelView,
} from '../lib/data-panel-state';
import { useUiPrefs } from '../lib/ui-prefs';
import './DataPanel.css';

export type PanelSortOrder = 'asc' | 'desc';
export type PanelQuery<Filters, SortKey extends string> = {
  filters: Filters;
  page: number;
  pageSize: number;
  sort?: { key: SortKey; order: PanelSortOrder };
};
export type PanelData<Row> = {
  rows: Row[];
  total: number;
  loading: boolean;
  error?: Error;
};

type FilterKey<Filters> = Extract<keyof Filters, string>;
export type PanelFilter<Filters> = {
  key: FilterKey<Filters>;
  label: string;
  advanced?: boolean;
  width?: number;
} & (
  | { kind: 'text'; placeholder?: string }
  | { kind: 'select'; options: ReadonlyArray<{ label: string; value: string | number }> }
  | { kind: 'numberRange'; min?: number; max?: number }
);

/** Sort keys are server API fields; column keys are stable UI preference keys. */
export type PanelColumn<Row, SortKey extends string> = Omit<
  ColumnType<Row>,
  'key' | 'sorter' | 'sortOrder' | 'defaultSortOrder' | 'filters' | 'onFilter'
> & {
  key: string;
  sortKey?: SortKey;
  hideable?: boolean;
};
export type PanelAction<Row> = {
  key: string;
  label: string;
  onClick: (row: Row) => void;
  disabled?: boolean;
  danger?: boolean;
};

export interface DataPanelProps<Row extends object, Filters extends object, SortKey extends string> {
  id: string;
  label: string;
  rowKey: (row: Row) => string;
  query: PanelQuery<Filters, SortKey>;
  /** Return false when domain validation rejects a submission; keep advanced dialog open. */
  onQueryChange: (next: PanelQuery<Filters, SortKey>) => void | boolean;
  initialFilters: Filters;
  data: PanelData<Row>;
  filters: readonly PanelFilter<Filters>[];
  /** The first N regular fields stay in the compact quick-search row; the rest use a collapsible row. */
  inlineFilterLimit?: number;
  columns: readonly PanelColumn<Row, SortKey>[];
  onRefresh?: () => void;
  renderCard?: (row: Row) => ReactNode;
  rowActions?: (row: Row) => readonly PanelAction<Row>[];
  toolbarExtra?: ReactNode;
  emptyText?: ReactNode;
  /** Page-owned copy for a failed read; the retry action stays on the panel. */
  errorTitle?: string;
  pageSizeOptions?: number[];
  /** Disable paging for complete, small datasets such as supplier registry. */
  pagination?: boolean;
}

export function DataPanel<Row extends object, Filters extends object, SortKey extends string>({
  id, label, rowKey, query, onQueryChange, initialFilters, data, filters,
  inlineFilterLimit = 3, columns, onRefresh, renderCard, rowActions, toolbarExtra, emptyText,
  errorTitle = '数据加载失败', pageSizeOptions = [10, 20, 50], pagination = true,
}: DataPanelProps<Row, Filters, SortKey>) {
  // AntD 6's deep NamePath type cannot prove a runtime schema key is a generic
  // recursive path. Keep Form's internal instance unparameterized; the public
  // PanelFilter keys and onFinish values remain typed by DataPanelProps/Filters.
  const [quickForm] = Form.useForm();
  const [advancedForm] = Form.useForm();
  const [extraExpanded, setExtraExpanded] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const regularFilters = filters.filter((filter) => !filter.advanced);
  const quickFilters = regularFilters.slice(0, Math.max(0, inlineFilterLimit));
  const extraFilters = regularFilters.slice(Math.max(0, inlineFilterLimit));
  const hasAdvanced = filters.some((filter) => filter.advanced);
  const saved = useUiPrefs((state) => state.dataPanels[id]);
  const setPreference = useUiPrefs((state) => state.setDataPanelPreference);
  const keys = columns.map((column) => column.key);
  const prefs = resolvePanelPreference(saved, keys, Boolean(renderCard));
  const requiredKeys = columns.filter((column) => column.hideable === false).map((column) => column.key);
  const visibleKeys = [...new Set([...prefs.visibleKeys, ...requiredKeys])];
  const { rows, total, loading, error } = data;

  useEffect(() => {
    // Browser back/forward synchronizes submitted quick filters. Never let
    // an unsent advanced draft leak into URL-owned query state.
    for (const filter of regularFilters) {
      quickForm.setFieldValue(String(filter.key), query.filters[filter.key]);
    }
  }, [quickForm, query.filters]);

  useEffect(() => {
    if (!advancedOpen) return;
    // Begin with the applied query, while respecting unsent quick-search edits.
    // Read ONLY regular fields: the quick form's initialValues also contains
    // advanced keys, which may be stale after browser back/forward navigation.
    const draft = { ...query.filters };
    for (const filter of regularFilters) {
      draft[filter.key] = quickForm.getFieldValue(String(filter.key));
    }
    for (const filter of filters) {
      advancedForm.setFieldValue(String(filter.key), draft[filter.key]);
    }
  }, [advancedOpen, advancedForm, quickForm, query.filters]);

  const submitQuick = (values: Partial<Filters>) => {
    onQueryChange({ ...query, filters: { ...query.filters, ...values }, page: 1 });
  };

  const submitAdvanced = (values: Filters) => {
    // An invalid domain-specific filter must remain editable in the dialog.
    if (onQueryChange({ ...query, filters: values, page: 1 }) !== false) {
      setAdvancedOpen(false);
    }
  };

  const resetAllFilters = () => {
    for (const filter of regularFilters) {
      quickForm.setFieldValue(String(filter.key), initialFilters[filter.key]);
    }
    onQueryChange({ ...query, filters: initialFilters, page: 1 });
  };

  const savePreference = (next: DataPanelPreference) => {
    setPreference(id, { ...prefs, ...next });
  };

  const toggleColumn = (key: string, checked: boolean) => {
    const next = checked ? [...visibleKeys, key] : visibleKeys.filter((value) => value !== key);
    if (next.length === 0) return;
    savePreference({ visibleKeys: next });
  };

  const orderedColumns = prefs.columnOrder
    .map((key) => columns.find((column) => column.key === key))
    .filter((column): column is PanelColumn<Row, SortKey> => Boolean(column));
  const activeColumns: ColumnType<Row>[] = orderedColumns
    .filter((column) => visibleKeys.includes(column.key))
    .map(({ sortKey, hideable: _hideable, ...column }) => {
      void _hideable;
      return {
        ...column,
        sorter: sortKey ? true : undefined,
        sortOrder: sortKey && query.sort?.key === sortKey
          ? (query.sort.order === 'asc' ? 'ascend' : 'descend')
          : null,
      };
    });
  if (rowActions) {
    activeColumns.push({
      title: '操作',
      key: '__panel_actions',
      fixed: 'right',
      width: 140,
      render: (_value, row) => (
        <Space size={0} wrap>
          {rowActions(row).map((action) => (
            <Button
              key={action.key}
              type="link"
              size="small"
              danger={action.danger}
              disabled={action.disabled}
              onClick={() => action.onClick(row)}
            >
              {action.label}
            </Button>
          ))}
        </Space>
      ),
    });
  }

  const onTableChange: TableProps<Row>['onChange'] = (pageState, _filters, sorter, extra) => {
    if (extra.action === 'sort') {
      const selected = Array.isArray(sorter) ? sorter[0] : sorter;
      const column = columns.find((item) => item.key === selected?.columnKey);
      const sort = selected?.order && column?.sortKey
        ? { key: column.sortKey, order: (selected.order === 'ascend' ? 'asc' : 'desc') as PanelSortOrder }
        : undefined;
      // All ordering is server-side; never rearrange the current page locally.
      onQueryChange({ ...query, page: 1, sort });
    } else if (extra.action === 'paginate') {
      const size = pageState.pageSize ?? query.pageSize;
      onQueryChange({
        ...query,
        page: size === query.pageSize ? (pageState.current ?? 1) : 1,
        pageSize: size,
      });
    }
  };

  const renderFilter = (filter: PanelFilter<Filters>, mode: 'inline' | 'modal') => {
    // The width belongs to the control, NOT the entire labelled Form.Item.
    // Fixing the wrapper width made AntD push input controls beneath labels.
    const controlWidth = mode === 'modal' ? '100%' : (filter.width ?? (filter.kind === 'text' ? 230 : 160));
    if (filter.kind === 'text') {
      return <Form.Item name={String(filter.key)} label={filter.label}>
        <Input allowClear placeholder={filter.placeholder} style={{ width: controlWidth, minWidth: 0 }} />
      </Form.Item>;
    }
    if (filter.kind === 'select') {
      return <Form.Item name={String(filter.key)} label={filter.label}>
        <Select options={[...filter.options]} style={{ width: controlWidth }} />
      </Form.Item>;
    }
    return <Form.Item label={filter.label}>
      <Space size={4} wrap={mode === 'modal'}>
        <Form.Item name={[String(filter.key), 'min']} noStyle>
          <InputNumber min={filter.min} max={filter.max} placeholder="最小值"
            aria-label={`${filter.label}最小值`} style={{ width: mode === 'modal' ? 136 : 104 }} />
        </Form.Item>
        <span aria-hidden="true">—</span>
        <Form.Item name={[String(filter.key), 'max']} noStyle>
          <InputNumber min={filter.min} max={filter.max} placeholder="最大值"
            aria-label={`${filter.label}最大值`} style={{ width: mode === 'modal' ? 136 : 104 }} />
        </Form.Item>
      </Space>
    </Form.Item>;
  };

  const settings = (
    <div className="data-panel-settings">
      <div className="data-panel-settings-title">显示列</div>
      {prefs.columnOrder.map((key, index) => {
        const column = columns.find((item) => item.key === key);
        if (!column) return null;
        const columnLabel = typeof column.title === 'string' ? column.title : column.key;
        return (
          <div key={key} className="data-panel-settings-row">
            <Checkbox
              checked={visibleKeys.includes(key)}
              disabled={column.hideable === false || (visibleKeys.length === 1 && visibleKeys.includes(key))}
              onChange={(event) => toggleColumn(key, event.target.checked)}
            >
              {columnLabel}
            </Checkbox>
            <Button
              aria-label={`上移${columnLabel}`}
              size="small" type="text" disabled={index === 0}
              icon={<ArrowUp size={14} />}
              onClick={() => savePreference({ columnOrder: moveColumn(prefs.columnOrder, key, -1) })}
            />
            <Button
              aria-label={`下移${columnLabel}`}
              size="small" type="text" disabled={index === prefs.columnOrder.length - 1}
              icon={<ArrowDown size={14} />}
              onClick={() => savePreference({ columnOrder: moveColumn(prefs.columnOrder, key, 1) })}
            />
          </div>
        );
      })}
      <div className="data-panel-settings-title">表格密度</div>
      <Segmented
        aria-label="表格密度"
        options={[
          { label: '紧凑', value: 'small' },
          { label: '标准', value: 'middle' },
          { label: '宽松', value: 'large' },
        ]}
        value={prefs.density}
        onChange={(value) => savePreference({ density: value as PanelDensity })}
      />
    </div>
  );

  const empty = emptyText ?? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无数据" />;
  return (
    <section className="panel-surface data-panel" aria-label={label}>
      <div className="panel-toolbar-row data-panel-toolbar-row">
        <Form<Filters>
          form={quickForm}
          className="panel-toolbar data-panel-form"
          layout="inline"
          initialValues={query.filters}
          onFinish={submitQuick}
        >
          <div className="data-panel-quick-line">
            {quickFilters.map((filter) => (
              <div key={filter.key} className="data-panel-filter">
                {renderFilter(filter, 'inline')}
              </div>
            ))}
            <Form.Item className="data-panel-form-actions">
              <Space size={6} wrap>
                <Button type="primary" htmlType="submit" icon={<Search size={14} />}>查询</Button>
                <Button icon={<RotateCcw size={14} />} onClick={resetAllFilters}>重置</Button>
                {hasAdvanced ? (
                  <Button type="link" onClick={() => setAdvancedOpen(true)}>高级检索</Button>
                ) : null}
                {extraFilters.length > 0 ? (
                  <Button type="link" aria-expanded={extraExpanded}
                    onClick={() => setExtraExpanded((value) => !value)}>
                    {extraExpanded ? '收起条件' : '更多条件'}
                  </Button>
                ) : null}
              </Space>
            </Form.Item>
          </div>
          {extraFilters.length > 0 ? (
            <div className="data-panel-extra-filters" aria-label="更多筛选条件" hidden={!extraExpanded}>
              {extraFilters.map((filter) => (
                <div key={filter.key} className="data-panel-filter">
                  {renderFilter(filter, 'inline')}
                </div>
              ))}
            </div>
          ) : null}
        </Form>
        <div className="panel-action data-panel-tools">
          <Space size={8} wrap>
            {toolbarExtra}
            {onRefresh ? <Button onClick={onRefresh}>刷新</Button> : null}
            {renderCard ? (
              <Segmented
                aria-label="数据视图"
                options={[{ label: '表格', value: 'table' }, { label: '卡片', value: 'card' }]}
                value={prefs.view}
                onChange={(view) => savePreference({ view: view as PanelView })}
              />
            ) : null}
            <Popover content={settings} trigger="click" placement="bottomRight">
              <Button aria-label="列设置" icon={<Settings2 size={16} />} />
            </Popover>
          </Space>
        </div>
      </div>
      {hasAdvanced ? (
        <Modal
          title="高级检索"
          aria-label="高级检索"
          open={advancedOpen}
          forceRender
          width={680}
          onCancel={() => setAdvancedOpen(false)}
          onOk={() => advancedForm.submit()}
          okText="查询"
          cancelText="取消"
        >
          <Form<Filters>
            form={advancedForm}
            layout="vertical"
            className="data-panel-advanced-form"
            initialValues={query.filters}
            onFinish={submitAdvanced}
          >
            <div className="data-panel-advanced-grid">
              {filters.map((filter) => (
                <div key={filter.key} className="data-panel-modal-filter">
                  {renderFilter(filter, 'modal')}
                </div>
              ))}
            </div>
            <Button onClick={() => {
              for (const filter of filters) {
                advancedForm.setFieldValue(String(filter.key), initialFilters[filter.key]);
              }
            }}>清空条件</Button>
          </Form>
        </Modal>
      ) : null}
      {error ? (
        <div className="panel-feedback">
          <Alert type="error" showIcon title={errorTitle} description={error.message}
            action={onRefresh ? <Button size="small" onClick={onRefresh}>重试</Button> : undefined} />
        </div>
      ) : prefs.view === 'card' && renderCard ? (
        <Spin spinning={loading}>
          <div className="data-panel-cards" role="list" aria-label="数据卡片">
            {rows.length === 0 && !loading ? empty : rows.map((row) => (
              <div key={rowKey(row)} className="data-panel-card" role="listitem">
                {renderCard(row)}
                {rowActions ? <Space size={4} wrap>
                  {rowActions(row).map((action) => (
                    <Button key={action.key} type="link" size="small" danger={action.danger}
                      disabled={action.disabled} onClick={() => action.onClick(row)}>{action.label}</Button>
                  ))}
                </Space> : null}
              </div>
            ))}
          </div>
          {pagination && total > 0 ? (
            <div className="data-panel-pagination">
              <Pagination current={query.page} pageSize={query.pageSize} total={total}
                pageSizeOptions={pageSizeOptions} showSizeChanger
                showTotal={(amount) => `共 ${amount} 条`}
                onChange={(page, size) => onQueryChange({
                  ...query, page: size === query.pageSize ? page : 1, pageSize: size,
                })} />
            </div>
          ) : null}
        </Spin>
      ) : (
        <Table<Row>
          rowKey={rowKey}
          columns={activeColumns}
          dataSource={rows}
          loading={loading}
          size={prefs.density}
          locale={{ emptyText: loading ? null : empty }}
          scroll={{ x: 'max-content' }}
          pagination={pagination ? {
            current: query.page, pageSize: query.pageSize, total,
            pageSizeOptions, showSizeChanger: true,
            showTotal: (amount) => `共 ${amount} 条`,
          } : false}
          onChange={onTableChange}
        />
      )}
    </section>
  );
}
