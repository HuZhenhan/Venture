import type { APIConfig, AIModel, ProviderKind } from '../types';
import { VentureClient } from '../sdk';
import { getBackendBaseUrl } from './backendClient';

export interface AddProviderParams {
  name: string;
  providerKind: ProviderKind;
  baseUrl: string;
  apiKey: string;
  models: AIModel[];
  inputContextWindow: number;
}

export interface UpdateProviderParams {
  name?: string;
  providerKind?: ProviderKind;
  baseUrl?: string;
  apiKey?: string;
  models?: AIModel[];
  inputContextWindow?: number;
}

const ventureClient = new VentureClient({ baseUrl: getBackendBaseUrl });

export async function listProviders(): Promise<APIConfig[]> {
  return ventureClient.listProviders();
}

export async function addProvider(params: AddProviderParams): Promise<APIConfig> {
  return ventureClient.addProvider(params);
}

export async function updateProvider(id: string, params: UpdateProviderParams): Promise<APIConfig> {
  return ventureClient.updateProvider(id, params);
}

export async function deleteProvider(id: string): Promise<void> {
  await ventureClient.deleteProvider(id);
}
