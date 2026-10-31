import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import React from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router';
import { ADMIN_BASE_PATH } from './app/base-path';
import { routes } from './app/routes';
import { adminTheme } from './app/theme';
import './style.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 15_000 },
  },
});

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider locale={zhCN} theme={adminTheme}>
      <AntdApp>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={createBrowserRouter(routes, { basename: ADMIN_BASE_PATH })} />
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>
  </React.StrictMode>,
);
