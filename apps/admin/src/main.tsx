import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider, type ThemeConfig } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { routes } from './app/routes';
import './style.css';

const theme: ThemeConfig = {
  token: {
    colorPrimary: '#2563EB',
    colorInfo: '#2563EB',
    colorText: '#1F2937',
    colorTextSecondary: '#64748B',
    colorBgLayout: '#F1F3F6',
    colorBorderSecondary: '#E5E7EB',
    borderRadius: 6,
    fontSize: 14,
  },
  components: {
    Layout: {
      headerBg: '#FFFFFF',
      bodyBg: '#F1F3F6',
      siderBg: '#FFFFFF',
      headerHeight: 48,
      headerPadding: '0 16px',
    },
    Menu: {
      itemSelectedBg: '#E8F0FE',
      itemSelectedColor: '#2563EB',
      itemHeight: 40,
    },
  },
};

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={theme}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={createBrowserRouter(routes)} />
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
