import { Space } from 'antd';
import { Navigate, useSearchParams } from 'react-router';
import { AccountsPanel } from '../features/settings/AccountsPanel';
import { AuditEventsPanel } from '../features/settings/AuditEventsPanel';
import { RuntimePanel } from '../features/settings/RuntimePanel';
import { SecurityPanel } from '../features/settings/SecurityPanel';
import {
  DEFAULT_SETTINGS_PATH,
  legacySettingsTabPath,
  settingsSectionMeta,
  type SettingsSection,
} from '../features/settings/sections';
import { PageHeader } from '../shared/components/PageHeader';

/**
 * One governance workspace per route. Operator accounts, security, the audit
 * trail and runtime facts are independent sidebar pages so each one owns its
 * work tab and a stable deep link; business configuration stays in its owning
 * domain (supplier catalogue, applications, value rules, interfaces).
 */
export function SettingsPage({ section }: { readonly section: SettingsSection }) {
  const meta = settingsSectionMeta(section);

  return (
    <div className="page">
      <PageHeader title={meta.label} description={meta.description} />

      <Space orientation="vertical" size={16} className="page-stack">
        <SettingsPanel section={section} />
      </Space>
    </div>
  );
}

function SettingsPanel({ section }: { readonly section: SettingsSection }) {
  if (section === 'accounts') return <AccountsPanel />;
  if (section === 'security') return <SecurityPanel />;
  if (section === 'audit') return <AuditEventsPanel />;
  return <RuntimePanel />;
}

/**
 * `/settings` is no longer a page of its own. Old bookmarks and the retired
 * `?tab=` links still land on the matching workspace instead of a blank route.
 */
export function SettingsEntryRedirect() {
  const [searchParams] = useSearchParams();
  const target = legacySettingsTabPath(searchParams.get('tab')) ?? DEFAULT_SETTINGS_PATH;
  return <Navigate to={target} replace />;
}
