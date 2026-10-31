/**
 * The operations console is mounted under `/admin`; the origin root belongs to
 * whatever the deployment serves there (today: a temporary 302 to this prefix).
 *
 * Keep this in sync with:
 * - `apps/api/src/static-assets.ts` (serves the SPA shell for `/admin` and
 *   `/admin/*`, and 404s every other non-API path)
 * - `.github/workflows/ci.yml` (runtime smoke checks)
 *
 * Route keys in `routes.tsx` stay relative (`/`, `/catalog`, …): React Router's
 * `basename` prepends this prefix for URLs and strips it from `useLocation()`,
 * so navigation keys, work-tab keys and persisted sessionStorage tabs do not
 * need a migration.
 */
export const ADMIN_BASE_PATH = '/admin';
