import type { ReactNode } from 'react';
import { Typography } from 'antd';
import './page-header.css';

const { Title, Paragraph } = Typography;

export interface PageHeaderProps {
  /**
   * Page title, rendered as the single h2 of the page head line. Child pages
   * that carry a breadcrumb omit it, because the last crumb is the heading.
   */
  readonly title?: ReactNode;
  /** One short supporting sentence. Omit it when the title is self-explanatory. */
  readonly description?: ReactNode;
  /**
   * Primary actions for this page, pinned on the right of the header line.
   * They belong to the header, so they never scroll away from the title.
   */
  readonly actions?: ReactNode;
  /** Status tags rendered inline with the title. */
  readonly status?: ReactNode;
  /**
   * Child pages replace the plain title with a breadcrumb that ends in the
   * current page, so the parent link is the only back affordance (design §4A).
   */
  readonly breadcrumb?: ReactNode;
  /** Extra class for the rare page that needs page-specific header layout. */
  readonly className?: string;
}

/**
 * The single route-level page head used by every workspace page.
 *
 * This is deliberately a shell-level primitive: the header is pinned chrome
 * above the scrolling body, so it must keep one identical geometry on every
 * route. Pages that hand-rolled their own <header className="page-header">
 * drifted apart (different title box, different actions row, an extra line of
 * prose), and that drift is what made switching work tabs look like the page
 * jumped. Every page must render this component instead of its own header.
 */
export function PageHeader({
  title,
  description,
  actions,
  status,
  breadcrumb,
  className,
}: PageHeaderProps) {
  /*
   * A child page supplies a breadcrumb whose last crumb is already the heading;
   * every other page gets one h2 so the page keeps a single, screen-reader
   * addressable title that is stable across route switches.
   */
  const titleLine = breadcrumb ?? (
    <Title level={2} className="page-header-heading">
      {title}
    </Title>
  );
  const hasRight = Boolean(actions);

  return (
    <header className={['page-header', className].filter(Boolean).join(' ')}>
      <div className="page-header-main">
        <div className="page-header-title">
          {titleLine}
          {status ? <div className="page-header-status">{status}</div> : null}
        </div>
        {description ? (
          <Paragraph type="secondary" className="page-header-description">
            {description}
          </Paragraph>
        ) : null}
      </div>
      {hasRight ? <div className="page-header-actions">{actions}</div> : null}
    </header>
  );
}
