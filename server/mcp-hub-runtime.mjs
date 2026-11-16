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
import { connectMcpPodmanServer } from './mcp-podman-runtime-adapter.mjs';
import { createMcpRootlessProfileProvider } from './mcp-rootless-profile-registry.mjs';
import { createMcpAdminApi } from './mcp-admin-api.mjs';


const profileForServer = createMcpRootlessProfileProvider();

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
    // No stdio fallback: every runtime must have an explicit deployment-owned
    // image profile and pass the rootless Podman capability probe.
    const server = getMcpServer(serverId);
    if (!server) {
      const error = new Error('MCP server is not registered');
      error.code = 'MCP_SERVER_NOT_FOUND';
      throw error;
    }
    const profile = profileForServer(serverId);
    return connectMcpPodmanServer({ serverId, profile });
  },
});

export const handleMcpAdminRequest = createMcpAdminApi({
  registry,
  supervisor: mcpRuntimeSupervisor,
});
