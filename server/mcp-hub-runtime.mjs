import {
  registerMcpServer,
  listMcpServers,
  getMcpServer,
  listMcpTools,
  setMcpToolPolicy,
  setMcpServerStatus,
  removeMcpServer,
} from './mcp-registry.mjs';
import { createMcpRuntimeSupervisor } from './mcp-runtime-supervisor.mjs';
import { connectMcpStdioServer } from './mcp-stdio-runtime-adapter.mjs';
import { createMcpDeploymentPolicyProvider } from './mcp-deployment-policy.mjs';
import { createMcpAdminApi } from './mcp-admin-api.mjs';

const policyFor = createMcpDeploymentPolicyProvider();

const registry = Object.freeze({
  registerMcpServer,
  listMcpServers,
  getMcpServer,
  listMcpTools,
  setMcpToolPolicy,
  setMcpServerStatus,
  removeMcpServer,
});

export const mcpRuntimeSupervisor = createMcpRuntimeSupervisor({
  connect: ({ serverId }) => {
    const server = getMcpServer(serverId);
    if (!server) {
      const error = new Error('MCP server is not registered');
      error.code = 'MCP_SERVER_NOT_FOUND';
      throw error;
    }
    const policy = policyFor(server);
    return connectMcpStdioServer({
      serverId,
      policy,
      ...(policy.credentialEnvKey ? { credentialEnvKey: policy.credentialEnvKey } : {}),
    });
  },
});

export const handleMcpAdminRequest = createMcpAdminApi({
  registry,
  supervisor: mcpRuntimeSupervisor,
});
