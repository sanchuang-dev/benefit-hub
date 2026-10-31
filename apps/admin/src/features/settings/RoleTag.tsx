import { Tag } from 'antd';
import type { AdminRole } from '../auth/api';

/** One role tag everywhere in settings so the two cards cannot disagree. */
export function RoleTag({ role }: { role: AdminRole }) {
  return role === 'admin' ? <Tag color="blue">管理员</Tag> : <Tag>只读</Tag>;
}
