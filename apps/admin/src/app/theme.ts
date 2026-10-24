import type { ThemeConfig } from 'antd';

export const adminTheme: ThemeConfig = {
  token: {
    colorPrimary: '#2563EB',
    colorInfo: '#2563EB',
    colorText: '#1F2937',
    colorTextSecondary: '#64748B',
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
  },
};
