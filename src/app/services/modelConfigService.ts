import type { APIConfig, AIModel } from '../types';
import { backendGet, backendPost, backendPatch, backendDelete } from './backendClient';

interface ProvidersResponse {
  providers: APIConfig[];
}

interface ProviderResponse {
  provider: APIConfig;
}

export interface AddProviderParams {
  name: string;
  baseUrl: string;
  apiKey: string;
  models: AIModel[];
  inputContextWindow: number;
  outputContextWindow: number;
}

export interface UpdateProviderParams {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: AIModel[];
  inputContextWindow?: number;
  outputContextWindow?: number;
}

export async function listProviders(): Promise<APIConfig[]> {
  const res = await backendGet<ProvidersResponse>('/api/providers');
  return res.providers;
}

export async function addProvider(params: AddProviderParams): Promise<APIConfig> {
  const res = await backendPost<ProviderResponse>('/api/providers', params);
  return res.provider;
}

export async function updateProvider(id: string, params: UpdateProviderParams): Promise<APIConfig> {
  const res = await backendPatch<ProviderResponse>(`/api/providers/${id}`, params);
  return res.provider;
}

export async function deleteProvider(id: string): Promise<void> {
  await backendDelete(`/api/providers/${id}`);
}
