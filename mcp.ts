// mcp.ts — Model Context Protocol over Streamable HTTP (JSON-RPC 2.0).
// Modern era: server/discover (revision 2026-07-28) is the primary path;
// the legacy `initialize` handshake is also answered. Tools act on the
// SAME store as REST, so MCP-created repos/issues read back over /api/v3.

import type { Repo, Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const MCP_SERVER_NAME = 'github-core-clone-01';
export const MCP_SERVER_VERSION = '1.0.0';

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties?: boolean;
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login (the authenticated user).' },
        name: { type: 'string', description: 'Repository name.' },
        description: { type: 'string', description: 'Repository description.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Issue title.' },
        body: { type: 'string', description: 'Issue body.' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        title: { type: 'string', description: 'Pull request title.' },
        body: { type: 'string', description: 'Pull request body.' },
        head: { type: 'string', description: 'Head branch name.' },
        base: { type: 'string', description: 'Base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request (squash) in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Owner login.' },
        repo: { type: 'string', description: 'Repository name.' },
        pull_number: { type: 'number', description: 'Pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent: unknown;
  isError: boolean;
}

function toolOk(obj: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], structuredContent: obj, isError: false };
}

function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], structuredContent: { error: message }, isError: true };
}

function getRepoOrError(store: Store, args: Record<string, unknown>): Repo | ToolResult {
  const owner = String(args.owner ?? '');
  const repoName = String(args.repo ?? '');
  const repo = store.getRepo(owner, repoName);
  if (!repo) return toolError(`repository ${owner}/${repoName} not found`);
  return repo;
}

export function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const normalized = name.toLowerCase();
  const tool = MCP_TOOLS.find((t) => t.name === normalized || normalized.endsWith(`/${t.name}`) || normalized.endsWith(`:${t.name}`));
  if (!tool) return toolError(`unknown tool: ${name}`);
  const missing = tool.inputSchema.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
  if (missing.length > 0) {
    return toolError(`missing required argument(s): ${missing.join(', ')}`);
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = String(args.name);
      const description = typeof args.description === 'string' ? args.description : '';
      const isPrivate = args.private === true;
      const repo = store.createRepo(repoName, description, isPrivate);
      return toolOk(repoJson(store, repo));
    }
    case 'get_repo': {
      const repo = getRepoOrError(store, args);
      if ('isError' in repo) return repo;
      return toolOk(repoJson(store, repo));
    }
    case 'create_issue': {
      const repo = getRepoOrError(store, args);
      if ('isError' in repo) return repo;
      const created = store.createIssue(repo, String(args.title), typeof args.body === 'string' ? args.body : '', []);
      if ('error' in created) return toolError(created.error);
      return toolOk(issueJson(store, repo, created));
    }
    case 'list_issues': {
      const repo = getRepoOrError(store, args);
      if ('isError' in repo) return repo;
      const state = typeof args.state === 'string' ? args.state.toLowerCase() : 'open';
      const issues = repo.issues.filter((i) => state === 'all' || i.state === state);
      const result = { issues: issues.map((i) => issueJson(store, repo, i)) };
      return toolOk(result);
    }
    case 'create_pull_request': {
      const repo = getRepoOrError(store, args);
      if ('isError' in repo) return repo;
      const created = store.createPull(
        repo,
        String(args.title),
        typeof args.body === 'string' ? args.body : '',
        String(args.head),
        String(args.base),
      );
      if ('error' in created) return toolError(created.error);
      return toolOk(pullJson(store, repo, created));
    }
    case 'merge_pull_request': {
      const repo = getRepoOrError(store, args);
      if ('isError' in repo) return repo;
      const number = Number(args.pull_number);
      const pull = repo.pulls.find((p) => p.number === number);
      if (!pull) return toolError(`pull request #${number} not found`);
      const merged = store.mergePull(repo, pull);
      if ('error' in merged) return toolError(merged.error);
      return toolOk({ ...pullJson(store, repo, pull), merged: true, sha: merged.sha });
    }
    default:
      return toolError(`unknown tool: ${name}`);
  }
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpResponse {
  status: number;
  body: Buffer | null; // null = empty body (202 for notifications)
}

/** Handle one MCP POST. `headers` carries the protocol version + method. */
export function handleMcp(store: Store, rawBody: Buffer, headers: { protocolVersion: string | null; method: string | null }): McpResponse {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(rawBody.toString('utf8')) as JsonRpcRequest;
  } catch {
    const body = Buffer.from(JSON.stringify({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    }));
    return { status: 400, body };
  }
  const id = request.id === undefined ? null : request.id;
  const method = request.method ?? headers.method ?? '';
  const isNotification = request.id === undefined || request.id === null;

  const result = (payload: unknown): McpResponse => ({
    status: 200,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, result: payload })),
  });
  const error = (code: number, message: string, status = 200): McpResponse => ({
    status,
    body: Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })),
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: MCP_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: {
        'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      },
    });
  }
  if (method === 'initialize') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : MCP_REVISIONS[0];
    const protocolVersion = MCP_REVISIONS.includes(requested) ? requested : MCP_REVISIONS[1];
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'tools/list') {
    return result({ tools: MCP_TOOLS });
  }
  if (method === 'tools/call') {
    const params = (request.params ?? {}) as Record<string, unknown>;
    const toolName = String(params.name ?? '');
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const known = MCP_TOOLS.some((t) => t.name === toolName.toLowerCase());
    if (!known) {
      return error(-32601, `Method not found: ${toolName}`);
    }
    const toolResult = callTool(store, toolName, args);
    return result(toolResult);
  }
  if (isNotification) {
    return { status: 202, body: null };
  }
  return error(-32601, `Method not found: ${method}`);
}
