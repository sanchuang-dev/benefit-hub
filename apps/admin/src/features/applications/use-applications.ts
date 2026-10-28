import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/lib/api-client';
import {
  createApplication,
  fetchApplication,
  fetchApplications,
  issueApplicationCredential,
  revokeApplicationCredential,
  setApplicationProducts,
  setApplicationStatus,
  updateApplication,
  type ApplicationCredential,
  type ApplicationListParams,
  type ApplicationListResponse,
  type ApplicationProductsChange,
  type ApplicationStatusChange,
  type BusinessApplication,
  type CreateApplicationInput,
  type ApplicationDetailResponse,
  type IssuedApplicationCredential,
} from './api';

export const applicationQueryKeys = {
  root: ['applications'] as const,
  list: (params: ApplicationListParams) => ['applications', 'list', params] as const,
  detail: (id: string) => ['applications', 'detail', id] as const,
};

export function useApplicationsQuery(params: ApplicationListParams) {
  return useQuery<ApplicationListResponse, ApiError>({
    queryKey: applicationQueryKeys.list(params),
    queryFn: () => fetchApplications(params),
    placeholderData: keepPreviousData,
    retry: false,
  });
}

/**
 * Detail is read through the real single-application endpoint so edits carry the
 * server's current version and configured product set, not a stale list row.
 */
export function useApplicationQuery(id: string | undefined) {
  return useQuery<ApplicationDetailResponse, ApiError>({
    queryKey: applicationQueryKeys.detail(id ?? ''),
    queryFn: () => {
      if (!id) throw new Error('应用 ID 缺失');
      return fetchApplication(id);
    },
    enabled: Boolean(id),
    staleTime: 0,
    retry: false,
  });
}

function useApplicationInvalidation() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: applicationQueryKeys.root });
}

export function useCreateApplicationMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<BusinessApplication, ApiError, CreateApplicationInput>({
    mutationFn: createApplication,
    onSuccess: () => {
      void invalidate();
    },
  });
}

export interface UpdateApplicationVariables {
  id: string;
  version: number;
  input: { name?: string; note?: string };
}

export function useUpdateApplicationMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<BusinessApplication, ApiError, UpdateApplicationVariables>({
    mutationFn: ({ id, version, input }) => updateApplication(id, version, input),
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useSetApplicationStatusMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<BusinessApplication, ApiError, ApplicationStatusChange>({
    mutationFn: setApplicationStatus,
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useSetApplicationProductsMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<ApplicationDetailResponse, ApiError, ApplicationProductsChange>({
    mutationFn: setApplicationProducts,
    onSuccess: () => {
      void invalidate();
    },
  });
}

/**
 * Issuing returns the raw secret. It is intentionally not cached: the drawer
 * keeps it in component state and drops it when the one-time view closes.
 */
export function useIssueApplicationCredentialMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<IssuedApplicationCredential, ApiError, string>({
    mutationFn: issueApplicationCredential,
    onSuccess: () => {
      void invalidate();
    },
  });
}

export function useRevokeApplicationCredentialMutation() {
  const invalidate = useApplicationInvalidation();
  return useMutation<
    ApplicationCredential,
    ApiError,
    { id: string; credentialId: string }
  >({
    mutationFn: ({ id, credentialId }) => revokeApplicationCredential(id, credentialId),
    onSuccess: () => {
      void invalidate();
    },
  });
}
