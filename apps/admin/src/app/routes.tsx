import type { RouteObject } from 'react-router';
import { LoginPage } from '../pages/LoginPage';
import { OverviewPage } from '../pages/OverviewPage';
import { CatalogPage } from '../pages/CatalogPage';
import { ApplicationsPage } from '../pages/ApplicationsPage';
import { FulfillmentPage } from '../pages/FulfillmentPage';
import { SettingsPage } from '../pages/SettingsPage';
import { PlatformModulesPage } from '../pages/PlatformModulesPage';
import { SuppliersPage, SupplierDetailPage } from '../pages/SuppliersPage';
import { ProtectedLayout } from './ProtectedLayout';

export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  {
    path: '/',
    element: <ProtectedLayout />,
    children: [
      { index: true, element: <OverviewPage /> },
      { path: 'catalog', element: <CatalogPage /> },
      { path: 'suppliers', element: <SuppliersPage /> },
      { path: 'suppliers/yangmao', element: <SupplierDetailPage /> },
      { path: 'applications', element: <ApplicationsPage /> },
      { path: 'value-rules', element: <PlatformModulesPage module="values" /> },
      { path: 'interfaces', element: <PlatformModulesPage module="interfaces" /> },
      { path: 'fulfillment', element: <FulfillmentPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
];
