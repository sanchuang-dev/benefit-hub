import type { ThemeConfig } from 'antd';

export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563EB',
    colorInfo: '#2563EB',
    colorText: '#1F2937',
    colorTextSecondary: '#64748B',
    colorTextDescription: '#64748B',
    colorBgLayout: '#F5F6F8',
    colorBgContainer: '#FFFFFF',
    colorBorder: '#DFE3E8',
    colorBorderSecondary: '#E8EAED',
    borderRadius: 4,
    controlHeight: 32,
    fontSize: 14,
  },
  components: {
    Layout: {
      headerBg: '#FFFFFF',
      bodyBg: '#F5F6F8',
      siderBg: '#FFFFFF',
      headerHeight: 52,
      headerPadding: '0 16px',
    },
    Descriptions: { labelColor: '#64748B' },
    Segmented: { itemColor: '#64748B' },
    Menu: {
      itemSelectedBg: '#EAF2FF',
      itemSelectedColor: '#2563EB',
      itemHeight: 36,
    },
    // Desktop operations tables: ~44px rows with stable header treatment.
    Table: {
      headerBg: '#FAFBFC',
      headerColor: '#475569',
      headerSplitColor: '#EEF0F2',
      rowHoverBg: '#F5F8FF',
      cellPaddingBlockMD: 10,
      cellPaddingInlineMD: 16,
    },
  },
};
