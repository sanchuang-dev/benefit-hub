import type { RouteObject } from 'react-router';
import { LoginPage } from '../pages/LoginPage';
import { OverviewPage } from '../pages/OverviewPage';
import { CatalogPage } from '../pages/CatalogPage';
import { ApplicationsPage } from '../pages/ApplicationsPage';
import { FulfillmentPage } from '../pages/FulfillmentPage';
import { SettingsEntryRedirect, SettingsPage } from '../pages/SettingsPage';
import { SETTINGS_SECTIONS } from '../features/settings/sections';
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
      // `/settings` only redirects now; every governance workspace is its own
      // sidebar page with its own work tab.
      { path: 'settings', element: <SettingsEntryRedirect /> },
      ...SETTINGS_SECTIONS.map((section) => ({
        path: `settings/${section.key}`,
        element: <SettingsPage section={section.key} />,
      })),
    ],
  },
];
