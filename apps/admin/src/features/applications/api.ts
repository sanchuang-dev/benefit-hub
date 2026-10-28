import { apiRequest } from '../../shared/lib/api-client';

export const APPLICATION_STATUSES = ['enabled', 'disabled'] as const;
export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

/**
 * Mirrors the application registry HTTP DTO. `activeCredentialCount` is a
 * non-secret fact; the raw Bearer token never appears in a read model and is
 * returned only once by the issue operation.
 */
export interface BusinessApplication {
  id: string;
  businessSource: string;
  name: string;
  note: string;
  status: ApplicationStatus;
  version: number;
  configuredProductCount: number;
  activeCredentialCount: number;
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

export const APPLICATION_CREDENTIAL_STATUSES = ['active', 'revoked'] as const;
export type ApplicationCredentialStatus = (typeof APPLICATION_CREDENTIAL_STATUSES)[number];

/** Operator-visible credential state. There is no field for the secret. */
export interface ApplicationCredential {
  id: string;
  status: ApplicationCredentialStatus;
  issuedAt: number;
  revokedAt: number | null;
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
  runtimeAuthorizationEnforced: true;
}

export interface ApplicationDetailResponse {
  application: BusinessApplication;
  products: ApplicationProduct[];
  credentials: ApplicationCredential[];
  runtimeAuthorizationEnforced: true;
}

interface ApplicationResponse {
  application: BusinessApplication;
}

/** The only response shape that carries a raw token, and only once. */
export interface IssuedApplicationCredential {
  credential: ApplicationCredential;
  secret: string;
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
 * never mint or reveal a machine token, but a disabled application cannot call
 * the machine order API until it is enabled again.
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

/**
 * Issues an additional machine credential. The response secret must stay in the
 * drawer's local state only: never in the query cache, storage or a log.
 */
export function issueApplicationCredential(id: string): Promise<IssuedApplicationCredential> {
  return apiRequest<IssuedApplicationCredential>(`/api/v1/applications/${id}/credentials`, {
    method: 'POST',
  });
}

/** Revokes one credential; the caller is rejected on its next request. */
export async function revokeApplicationCredential(
  id: string,
  credentialId: string,
): Promise<ApplicationCredential> {
  const body = await apiRequest<{ credential: ApplicationCredential }>(
    `/api/v1/applications/${id}/credentials/${credentialId}/revoke`,
    { method: 'POST' },
  );
  return body.credential;
}
