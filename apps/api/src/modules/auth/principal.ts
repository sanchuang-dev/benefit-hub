import type { AdminRole } from './accounts.js';

export interface SessionPrincipal {
  id: string;
  username: string;
  displayName: string;
  role: AdminRole;
}

interface PrincipalRow {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

/**
 * The only place a database role string becomes a typed principal. An unknown
 * role value is a data-integrity failure, not a silent downgrade/upgrade.
 */
export function toPrincipal(row: PrincipalRow): SessionPrincipal {
  if (row.role !== 'admin' && row.role !== 'viewer') {
    throw new Error(`Unknown admin role stored in database: ${row.role}`);
  }
  return {
    id: row.id,
    username: row.username,
    displayName: row.displayName,
    role: row.role,
  };
}
