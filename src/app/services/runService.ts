import { backendGet } from './backendClient';

export type RunKind = 'chat' | 'tool' | 'subagent' | 'workflow';
export type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
export type RunTerminalReason =
  | 'completed'
  | 'user_cancelled'
  | 'upstream_error'
  | 'tool_error'
  | 'permission_denied'
  | 'subagent_error'
  | 'workflow_error'
  | 'unknown_error';

export interface RunSummary {
  id: string;
  kind: RunKind;
  status: RunStatus;
  title: string;
  chatId?: string;
  parentRunId?: string;
  externalId?: string;
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  terminalReason?: RunTerminalReason;
  error?: string;
  metadata?: unknown;
}

export async function listRuns(chatId?: string): Promise<RunSummary[]> {
  const query = chatId ? `?chatId=${encodeURIComponent(chatId)}` : '';
  const result = await backendGet<{ runs: RunSummary[] }>(`/api/runs${query}`);
  return result.runs;
}

export async function getRun(runId: string): Promise<RunSummary> {
  return backendGet<RunSummary>(`/api/runs/${encodeURIComponent(runId)}`);
}
