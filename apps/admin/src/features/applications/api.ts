import { apiRequest } from '../../shared/lib/api-client';

export const APPLICATION_STATUSES = ['enabled', 'disabled'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Mirrors the BHB-014-A HTTP DTO. This is configuration only: an application
 * that is enabled with a configured product allowlist has still not obtained a
 * callable machine credential. `runtimeAuthorizationEnforced` is fixed false in
 * this slice and must never be read as effective permission.
 */
export interface BusinessApplication {
  id: string;
  businessSource: string;
  name: string;
  note: string;
  status: ApplicationStatus;
  version: number;
  configuredProductCount: number;
  runtimeAuthorizationEnforced: false;
  createdAt: number;
  updatedAt: number;
}

export interface ApplicationProduct {
  productId: string;
  code: string;
  name: string;
  status: 'active' | 'disabled';
  configuredAt: number;
}

export interface ApplicationListParams {
  page: number;
  pageSize: number;
  keyword?: string;
  status?: ApplicationStatus;
}

export interface ApplicationListResponse {
  applications: BusinessApplication[];
  page: number;
  pageSize: number;
  total: number;
  runtimeAuthorizationEnforced: false;
}

export interface ApplicationDetailResponse {
  application: BusinessApplication;
  products: ApplicationProduct[];
  runtimeAuthorizationEnforced: false;
}

interface ApplicationResponse {
  application: BusinessApplication;
}

export interface CreateApplicationInput {
  businessSource: string;
  name: string;
  note: string;
}

export interface UpdateApplicationInput {
  name?: string;
  note?: string;
}

export interface ApplicationStatusChange {
  id: string;
  status: ApplicationStatus;
  version: number;
}

export interface ApplicationProductsChange {
  id: string;
  version: number;
  productIds: string[];
}

export function fetchApplications(params: ApplicationListParams): Promise<ApplicationListResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.keyword) query.set('keyword', params.keyword);
  if (params.status) query.set('status', params.status);
  return apiRequest<ApplicationListResponse>(`/api/v1/applications?${query.toString()}`);
}

export function fetchApplication(id: string): Promise<ApplicationDetailResponse> {
  return apiRequest<ApplicationDetailResponse>(`/api/v1/applications/${id}`);
}

export async function createApplication(
  input: CreateApplicationInput,
): Promise<BusinessApplication> {
  const body = await apiRequest<ApplicationResponse>('/api/v1/applications', {
    method: 'POST',
    body: input,
  });
  return body.application;
}

export async function updateApplication(
  id: string,
  version: number,
  input: UpdateApplicationInput,
): Promise<BusinessApplication> {
  const body = await apiRequest<ApplicationResponse>(`/api/v1/applications/${id}`, {
    method: 'PATCH',
    body: { version, ...input },
  });
  return body.application;
}

/**
 * Enable and disable are separate, version-guarded configuration actions. They
 * never mint, reveal or revoke a machine token.
 */
export async function setApplicationStatus({
  id,
  status,
  version,
}: ApplicationStatusChange): Promise<BusinessApplication> {
  const body = await apiRequest<ApplicationResponse>(
    `/api/v1/applications/${id}/${status === 'enabled' ? 'enable' : 'disable'}`,
    { method: 'POST', body: { version } },
  );
  return body.application;
}

/** Replaces the complete configured internal-product set in one atomic write. */
export function setApplicationProducts({
  id,
  version,
  productIds,
}: ApplicationProductsChange): Promise<ApplicationDetailResponse> {
  return apiRequest<ApplicationDetailResponse>(`/api/v1/applications/${id}/products`, {
    method: 'PUT',
    body: { version, productIds },
  });
}
