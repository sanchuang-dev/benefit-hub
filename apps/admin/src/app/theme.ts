import type { ThemeConfig } from 'antd';

export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563EB',
    colorInfo: '#2563EB',
    colorText: '#1F2937',
    colorTextSecondary: '#64748B',
    // Typography `type="secondary"` and Empty descriptions read
    // `colorTextDescription` in antd 6, whose default rgba(0,0,0,0.45) is 3.35:1
    // on white — below WCAG AA for the 13-14px copy used across the shell.
    // Design §2 names #64748B for secondary text; apply it to that token too.
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
    // Descriptions labels default to colorTextTertiary (3.35:1 on white) and
    // Segmented's unselected items to colorTextLabel (~4.4:1 on the track). Use
    // the design's secondary-text token for these two component surfaces instead
    // of darkening the global tertiary/label tokens, which also style
    // placeholders and disabled content where the lighter step is intentional.
    Descriptions: {
      labelColor: '#64748B',
    },
    Segmented: {
      itemColor: '#64748B',
    },
  },
};
