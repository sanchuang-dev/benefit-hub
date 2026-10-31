/**
 * The four platform-governance workspaces. They used to be URL tabs of one
 * `/settings` page; they are independent sidebar pages now, so each one owns a
 * route, a work tab and a stable deep link.
 */
export const SETTINGS_SECTIONS = [
  {
    key: 'accounts',
    label: '账号与权限',
    path: '/settings/accounts',
    description: '当前账号、运营账号与角色状态；账号写操作仍由服务器端管理员工具执行。',
  },
  {
    key: 'security',
    label: '安全与会话',
    path: '/settings/security',
    description: '当前会话与生效安全策略；只读展示服务端配置，不在页面修改运行环境。',
  },
  {
    key: 'audit',
    label: '操作审计',
    path: '/settings/audit',
    description: '登录、会话与账号变更事实；按时间倒序，仅管理员可查看。',
  },
  {
    key: 'runtime',
    label: '平台状态',
    path: '/settings/runtime',
    description: '服务、数据库、构建版本与能力配置的只读状态。',
  },
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]['key'];

export type SettingsSectionMeta = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SETTINGS_PATH = '/settings/accounts';

export function settingsSectionMeta(section: SettingsSection): SettingsSectionMeta {
  const meta = SETTINGS_SECTIONS.find((item) => item.key === section);
  if (!meta) throw new Error(`unknown settings section: ${section}`);
  return meta;
}

/**
 * Maps the retired `?tab=` deep link onto its standalone page. `/settings` and
 * unknown values return null so the entry redirect can fall back to accounts.
 */
export function legacySettingsTabPath(tab: string | null): string | null {
  if (!tab) return null;
  const section = SETTINGS_SECTIONS.find((item) => item.key === tab);
  return section?.path ?? null;
}
