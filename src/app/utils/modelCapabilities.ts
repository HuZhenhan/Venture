import type { AIModel, APIConfig, ModelCapabilities, ProviderKind } from '../types';

export const PROVIDER_KIND_OPTIONS: readonly ProviderKind[] = ['openai_compatible', 'deepseek'];

export const PROVIDER_KIND_LABELS: Record<ProviderKind, string> = {
  openai_compatible: 'OpenAI-compatible',
  deepseek: 'DeepSeek',
};

export function resolveModelCapabilities(
  model: AIModel,
  provider?: Pick<APIConfig, 'inputContextWindow'>,
): ModelCapabilities {
  return {
    supportsReasoning: model.capabilities?.supportsReasoning ?? false,
    supportsTools: model.capabilities?.supportsTools ?? false,
    supportsMultimodal: model.capabilities?.supportsMultimodal ?? model.supportsMultimodal ?? false,
    contextWindow: model.capabilities?.contextWindow ?? provider?.inputContextWindow,
  };
}

export function withResolvedModelCapabilities(
  model: AIModel,
  provider?: Pick<APIConfig, 'inputContextWindow'>,
): AIModel {
  const capabilities = resolveModelCapabilities(model, provider);
  return {
    ...model,
    supportsMultimodal: capabilities.supportsMultimodal,
    capabilities,
  };
}
