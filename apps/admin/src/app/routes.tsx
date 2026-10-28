import type { RouteObject } from 'react-router';
import { LoginPage } from '../pages/LoginPage';
import { OverviewPage } from '../pages/OverviewPage';
import { CatalogPage } from '../pages/CatalogPage';
import { FulfillmentPage } from '../pages/FulfillmentPage';
import { SettingsPage } from '../pages/SettingsPage';
import { PlatformModulesPage } from '../pages/PlatformModulesPage';
import { ProtectedLayout } from './ProtectedLayout';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'catalog', element: <CatalogPage /> },
      { path: 'suppliers', element: <PlatformModulesPage module="suppliers" /> },
      { path: 'applications', element: <PlatformModulesPage module="applications" /> },
      { path: 'value-rules', element: <PlatformModulesPage module="values" /> },
      { path: 'interfaces', element: <PlatformModulesPage module="interfaces" /> },
      { path: 'fulfillment', element: <FulfillmentPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
