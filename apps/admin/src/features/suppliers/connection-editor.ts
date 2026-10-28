import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiRequest, type ApiError } from '../../shared/lib/api-client';

export interface ConnectionEditorData {
  provider: 'yangmao';
  baseUrl: string;
  version: number;
  source: 'database' | 'environment' | 'none';
  hasCredentials: boolean;
  canSave: boolean;
}

export interface ConnectionInput {
  baseUrl: string;
  version: number;
  appKey?: string;
  appSecret?: string;
}

export function useConnectionEditorQuery(enabled: boolean) {
  return useQuery<{ connection: ConnectionEditorData }, ApiError>({
    queryKey: ['suppliers', 'yangmao', 'connection'],
    queryFn: () => apiRequest('/api/v1/suppliers/yangmao/connection'),
    enabled,
    retry: false,
  });
}

export function useConnectionSave() {
  const client = useQueryClient();
  return useMutation<{ connection: ConnectionEditorData }, ApiError, ConnectionInput>({
    mutationFn: (input) =>
      apiRequest('/api/v1/suppliers/yangmao/connection', { method: 'PUT', body: input }),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['suppliers'] });
      void client.invalidateQueries({ queryKey: ['catalog', 'supplier-products'] });
    },
  });
}
