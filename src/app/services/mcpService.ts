import { backendGet, backendPut } from './backendClient';

export type McpTransport = 'stdio' | 'http' | 'sse';
export type McpServerStatus = 'disabled' | 'configured' | 'starting' | 'online' | 'offline' | 'error';
export type McpPermissionScope = 'ask' | 'deny';

export interface McpServerConfig {
  id: string;
  name: string;
  transport: McpTransport;
  command?: string | null;
  url?: string | null;
  env: Record<string, string>;
  enabled: boolean;
  permissionScope: McpPermissionScope;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  serverId: string;
  serverName: string;
  requiresApproval: boolean;
}

export interface McpServerView {
  config: McpServerConfig;
  liveness: {
    status: McpServerStatus;
    message: string;
  };
  tools: McpToolDefinition[];
}

interface McpServersResponse {
  servers: McpServerView[];
}

export async function listMcpServers(): Promise<McpServerView[]> {
  const result = await backendGet<McpServersResponse>('/api/mcp/servers');
  return result.servers;
}

export async function replaceMcpServers(servers: McpServerConfig[]): Promise<McpServerView[]> {
  const result = await backendPut<McpServersResponse>('/api/mcp/servers', { servers });
  return result.servers;
}
