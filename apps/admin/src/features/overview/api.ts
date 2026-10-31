import type {
  OperationsOverviewDto,
  OperationsOverviewResponse,
  OverviewWindow,
} from '@sanchuang-dev/benefit-contracts';
import { apiRequest } from '../../shared/lib/api-client';

/** Read-only cockpit aggregate; the server owns every count and the `asOf` clock. */
export async function fetchOverview(window: OverviewWindow): Promise<OperationsOverviewDto> {
  const body = await apiRequest<OperationsOverviewResponse>(
    `/api/v1/operations/overview?window=${window}`,
  );
  return body.overview;
}
