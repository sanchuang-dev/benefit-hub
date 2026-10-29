import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../../shared/lib/api-client';
import { useUiPrefs } from '../../shared/lib/ui-prefs';
import {
  fetchAccounts,
  fetchSession,
  fetchSystemStatus,
  login,
  logout,
  type AccountSummary,
  type LoginResponse,
  type SessionResponse,
  type SystemStatus,
} from './api';

export const sessionQueryKey = ['auth', 'session'] as const;

export function useSessionQuery() {
  return useQuery<SessionResponse, ApiError>({
    queryKey: sessionQueryKey,
    queryFn: fetchSession,
    // A 401 is an expected unauthenticated state, not a transient failure.
    retry: false,
    staleTime: 30_000,
    // Detect expiry while the tab stays open instead of waiting for a write.
    refetchInterval: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

export function useLoginMutation() {
  const queryClient = useQueryClient();
  return useMutation<LoginResponse, ApiError, { username: string; password: string }>({
    mutationFn: ({ username, password }) => login(username, password),
    onSuccess: (data) => {
      queryClient.setQueryData<SessionResponse>(sessionQueryKey, {
        admin: data.admin,
        session: data.session,
      });
    },
  });
}

export function useLogoutMutation() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiError, void>({
    mutationFn: logout,
    onSuccess: () => {
      // A shared operations console must not leak the previous operator's
      // cached catalogue rows or restored work tabs into the next login.
      queryClient.removeQueries();
      useUiPrefs.getState().reset();
    },
  });
}

export function useAccountsQuery(enabled: boolean) {
  return useQuery<{ accounts: AccountSummary[] }, ApiError>({
    queryKey: ['admin', 'accounts'],
    queryFn: fetchAccounts,
    enabled,
    retry: false,
  });
}

export function useSystemStatusQuery() {
  return useQuery<SystemStatus, ApiError>({
    queryKey: ['system', 'status'],
    queryFn: fetchSystemStatus,
    staleTime: 60_000,
  });
}
