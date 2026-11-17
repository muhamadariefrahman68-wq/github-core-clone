// app.ts — HTTP server: routing, auth, JSON plumbing, REST v3, GraphQL,
// MCP and git smart HTTP. Everything is served from one in-memory Store.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './githttp.ts';
import { executeGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import {
  b64,
  commentJson,
  issueJson,
  linkHeader,
  paginate,
  parsePositiveInt,
  pullJson,
  repoJson,
} from './rest.ts';
import { Store } from './store.ts';

export function createStore(): Store {
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  return new Store(token, process.env.MAKEFUN_TRIAL_NOW);
}

function readBody(req: IncomingMessage, maxBytes = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = body === null ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-GitHub-Request-Id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(payload);
}

function sendRaw(res: ServerResponse, store: Store, status: number, contentType: string, body: Buffer, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'X-GitHub-Request-Id': store.nextRequestId(),
    ...extraHeaders,
  });
  res.end(body);
}

function sendError(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

function parseQuery(queryString: string): URLSearchParams {
  return new URLSearchParams(queryString);
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

interface Ctx {
  store: Store;
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  body: Buffer;
  json: Record<string, unknown> | null;
  host: string;
}

function baseUrl(ctx: Ctx): string {
  return `http://${ctx.host}`;
}

async function handleRest(ctx: Ctx): Promise<void> {
  const { store, res, segments, query } = ctx;
  const viewer = store.viewer.login;

  // GET /api/v3/ — root (no auth needed, GitHub answers it publicly).
  if (segments.length === 0) {
    if (ctx.req.method !== 'GET') return sendError(res, store, 404, 'Not Found');
    return sendJson(res, store, 200, {
      current_user_url: '/api/v3/user',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      user_url: '/api/v3/users/{username}',
    }, { 'X-OAuth-Scopes': 'repo, read:org' });
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (ctx.req.method !== 'GET') return sendError(res, store, 404, 'Not Found');
    return sendJson(res, store, 200, {
      installed_version: '1.0.0',
      verifiable_password_authentication: true,
      ssh_key_fingerprints: {},
      hooks: [],
      git: [],
      github_enterprise_importer: [],
      pages: [],
      importer: [],
      actions: [],
      packages: [],
      dependabot: [],
    });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (ctx.req.method !== 'GET') return sendError(res, store, 404, 'Not Found');
    return sendJson(res, store, 200, {
      login: viewer,
      id: store.viewer.id,
      node_id: b64(`User:${viewer}`),
      name: store.viewer.name,
      email: store.viewer.email,
      type: 'User',
      html_url: `https://github.com/${viewer}`,
      url: '/api/v3/user',
    });
  }

  if (segments[0] === 'user' && segments[1] === 'repos') {
    if (segments.length !== 2) return sendError(res, store, 404, 'Not Found');
    if (ctx.req.method === 'GET') {
      const perPage = Math.min(100, parsePositiveInt(query.get('per_page'), 30));
      const page = parsePositiveInt(query.get('page'), 1);
      const repos = store.listViewerRepos();
      const pageItems = paginate(repos, page, perPage);
      const link = linkHeader(`${baseUrl(ctx)}/api/v3/user/repos`, page, perPage, repos.length);
      return sendJson(res, store, 200, pageItems.map((r) => repoJson(store, r)), link ? { Link: link } : {});
    }
    if (ctx.req.method === 'POST') {
      const body = ctx.json ?? {};
      const name = typeof body.name === 'string' ? body.name : '';
      if (name.length === 0) return sendError(res, store, 422, 'Validation Failed: name is required');
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return sendError(res, store, 422, 'Validation Failed: invalid repository name');
      if (store.getRepo(viewer, name)) {
        return sendError(res, store, 422, `Validation Failed: name already exists on this account`);
      }
      const description = typeof body.description === 'string' ? body.description : '';
      const isPrivate = body.private === true;
      const repo = store.createRepo(name, description, isPrivate);
      return sendJson(res, store, 201, repoJson(store, repo));
    }
    return sendError(res, store, 404, 'Not Found');
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = decodeSegment(segments[1]);
    const repoName = decodeSegment(segments[2]);
    const rest = segments.slice(3);
    const repo = owner === viewer ? store.getRepo(owner, repoName) : undefined;
    if (!repo) return sendError(res, store, 404, 'Not Found');

    // /repos/{o}/{r}
    if (rest.length === 0) {
      if (ctx.req.method === 'GET') return sendJson(res, store, 200, repoJson(store, repo));
      if (ctx.req.method === 'PATCH') {
        const body = ctx.json ?? {};
        if (typeof body.description === 'string') repo.description = body.description;
        if (body.private === true || body.private === false) repo.private = body.private;
        return sendJson(res, store, 200, repoJson(store, repo));
      }
      if (ctx.req.method === 'DELETE') {
        store.deleteRepo(repo);
        res.writeHead(204, { 'X-GitHub-Request-Id': store.nextRequestId() });
        res.end();
        return;
      }
      return sendError(res, store, 404, 'Not Found');
    }

    // /repos/{o}/{r}/branches
    if (rest[0] === 'branches' && rest.length === 1 && ctx.req.method === 'GET') {
      const branches: Array<{ name: string; commit: { sha: string }; protected: boolean }> = [];
      for (const [refName, oid] of repo.refs) {
        if (!refName.startsWith('refs/heads/')) continue;
        branches.push({ name: refName.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
      }
      branches.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
      return sendJson(res, store, 200, branches);
    }

    // /repos/{o}/{r}/branches/{branch}
    if (rest[0] === 'branches' && rest.length === 2 && ctx.req.method === 'GET') {
      const branch = decodeSegment(rest[1]);
      const tip = store.branchTip(repo, branch);
      if (tip === null) return sendError(res, store, 404, 'Not Found');
      return sendJson(res, store, 200, { name: branch, commit: { sha: tip }, protected: false });
    }

    // /repos/{o}/{r}/commits
    if (rest[0] === 'commits' && rest.length === 1 && ctx.req.method === 'GET') {
      const ref = query.get('sha') ?? repo.defaultBranch;
      const records = store.listCommits(repo, ref);
      const perPage = Math.min(100, parsePositiveInt(query.get('per_page'), 30));
      const page = parsePositiveInt(query.get('page'), 1);
      const pageItems = paginate(records, page, perPage);
      return sendJson(res, store, 200, pageItems.map((c) => ({
        sha: c.sha,
        commit: {
          message: c.message,
          author: { name: c.authorName, email: c.authorEmail, date: c.authorDate },
          committer: { name: c.committerName, email: c.committerEmail, date: c.committerDate },
          tree: { sha: c.tree },
        },
        parents: c.parents.map((sha) => ({ sha })),
        author: { login: viewer },
        committer: { login: viewer },
      })));
    }

    // /repos/{o}/{r}/git/refs
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && ctx.req.method === 'POST') {
        const body = ctx.json ?? {};
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/')) return sendError(res, store, 422, 'Validation Failed: ref must start with refs/');
        if (!/^[0-9a-f]{40}$/.test(sha) || !repo.objects.get(sha)) return sendError(res, store, 422, 'Validation Failed: object does not exist');
        if (repo.refs.has(ref)) return sendError(res, store, 422, 'Validation Failed: reference already exists');
        repo.refs.set(ref, sha);
        store.invalidatePackCache();
        return sendJson(res, store, 201, { ref, object: { sha, type: repo.objects.get(sha)?.type ?? 'commit' } });
      }
      if (rest.length === 4 && rest[2] === 'heads' && ctx.req.method === 'GET') {
        const branch = decodeSegment(rest[3]);
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (tip === undefined) return sendError(res, store, 404, 'Not Found');
        return sendJson(res, store, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
      }
      return sendError(res, store, 404, 'Not Found');
    }

    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeSegment).join('/');
      if (ctx.req.method === 'GET') {
        const ref = query.get('ref') ?? repo.defaultBranch;
        const found = store.readPath(repo, ref, path);
        if (found === null) return sendError(res, store, 404, 'Not Found');
        if (found.kind === 'file') {
          return sendJson(res, store, 200, {
            type: 'file',
            encoding: 'base64',
            size: found.content.length,
            name: path.split('/').pop() ?? path,
            path,
            content: found.content.toString('base64'),
            sha: found.entry.oid,
          });
        }
        return sendJson(res, store, 200, found.entries.map((e) => ({
          type: e.mode === '40000' ? 'dir' : 'file',
          size: e.mode === '40000' ? 0 : (repo.objects.get(e.oid)?.data.length ?? 0),
          name: e.name,
          path: e.path,
          sha: e.oid,
        })));
      }
      if (ctx.req.method === 'PUT') {
        const body = ctx.json ?? {};
        const message = typeof body.message === 'string' ? body.message : `Update ${path}`;
        const contentB64 = typeof body.content === 'string' ? body.content : '';
        if (contentB64.length === 0) return sendError(res, store, 422, 'Validation Failed: content is required');
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const content = Buffer.from(contentB64, 'base64');
        // Stale-sha check: updating an existing file with a wrong sha -> 409.
        const existing = store.readPath(repo, branch, path);
        if (existing !== null && existing.kind === 'file' && typeof body.sha === 'string') {
          if (body.sha !== existing.entry.oid) {
            return sendError(res, store, 409, 'Validation Failed: sha does not match the current file');
          }
        }
        const { commitSha, blobSha, created } = store.putFile(repo, branch, path, content, message);
        return sendJson(res, store, created ? 201 : 200, {
          content: {
            name: path.split('/').pop() ?? path,
            path,
            sha: blobSha,
            size: content.length,
            encoding: 'base64',
            content: contentB64,
          },
          commit: { sha: commitSha, message },
        });
      }
      if (ctx.req.method === 'DELETE') {
        const body = ctx.json ?? {};
        const message = typeof body.message === 'string' ? body.message : `Delete ${path}`;
        const branch = typeof body.branch === 'string' ? body.branch : repo.defaultBranch;
        const existing = store.readPath(repo, branch, path);
        if (existing === null || existing.kind !== 'file') return sendError(res, store, 404, 'Not Found');
        if (typeof body.sha === 'string' && body.sha !== existing.entry.oid) {
          return sendError(res, store, 409, 'Validation Failed: sha does not match the current file');
        }
        const deleted = store.deleteFile(repo, branch, path, message);
        if (deleted === null) return sendError(res, store, 404, 'Not Found');
        return sendJson(res, store, 200, { commit: { sha: deleted.commitSha, message } });
      }
      return sendError(res, store, 404, 'Not Found');
    }

    // /repos/{o}/{r}/labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && ctx.req.method === 'GET') {
        return sendJson(res, store, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color })));
      }
      if (rest.length === 1 && ctx.req.method === 'POST') {
        const body = ctx.json ?? {};
        const name = typeof body.name === 'string' ? body.name : '';
        const color = typeof body.color === 'string' ? body.color : 'ededed';
        if (name.length === 0) return sendError(res, store, 422, 'Validation Failed: name is required');
        const existing = repo.labels.get(name);
        if (existing) return sendJson(res, store, 201, { name: existing.name, color: existing.color });
        repo.labels.set(name, { name, color });
        return sendJson(res, store, 201, { name, color });
      }
      return sendError(res, store, 404, 'Not Found');
    }

    // /repos/{o}/{r}/issues
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (ctx.req.method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          const sort = query.get('sort') ?? 'created';
          const direction = (query.get('direction') ?? 'desc').toLowerCase();
          let issues = [...repo.issues];
          if (state !== 'all') issues = issues.filter((i) => i.state === state);
          if (sort === 'created') {
            issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
          }
          const perPage = Math.min(100, parsePositiveInt(query.get('per_page'), 30));
          const page = parsePositiveInt(query.get('page'), 1);
          const pageItems = paginate(issues, page, perPage);
          const link = linkHeader(`${baseUrl(ctx)}/api/v3/repos/${owner}/${repoName}/issues`, page, perPage, issues.length);
          return sendJson(res, store, 200, pageItems.map((i) => issueJson(store, repo, i)), link ? { Link: link } : {});
        }
        if (ctx.req.method === 'POST') {
          const body = ctx.json ?? {};
          const title = typeof body.title === 'string' ? body.title : '';
          if (title.length === 0) return sendError(res, store, 422, 'Validation Failed: title is required');
          const bodyText = typeof body.body === 'string' ? body.body : '';
          const labels = Array.isArray(body.labels)
            ? (body.labels as unknown[]).map((l) => (typeof l === 'string' ? l : (l as Record<string, unknown>).name as string)).filter(Boolean)
            : [];
          const created = store.createIssue(repo, title, bodyText, labels);
          if ('error' in created) return sendError(res, store, 422, `Validation Failed: ${created.error}`);
          return sendJson(res, store, 201, issueJson(store, repo, created));
        }
        return sendError(res, store, 404, 'Not Found');
      }
      const issueNumber = Number.parseInt(rest[1], 10);
      const issue = repo.issues.find((i) => i.number === issueNumber);
      if (!issue) return sendError(res, store, 404, 'Not Found');
      if (rest.length === 2) {
        if (ctx.req.method === 'GET') return sendJson(res, store, 200, issueJson(store, repo, issue));
        if (ctx.req.method === 'PATCH') {
          const body = ctx.json ?? {};
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedAt = store.nowIso;
          return sendJson(res, store, 200, issueJson(store, repo, issue));
        }
        return sendError(res, store, 404, 'Not Found');
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (ctx.req.method === 'GET') {
          return sendJson(res, store, 200, issue.comments.map((c) => commentJson(store, repo, issue, c)));
        }
        if (ctx.req.method === 'POST') {
          const body = ctx.json ?? {};
          const text = typeof body.body === 'string' ? body.body : '';
          if (text.length === 0) return sendError(res, store, 422, 'Validation Failed: body is required');
          const comment = store.addComment(repo, issue, text);
          return sendJson(res, store, 201, commentJson(store, repo, issue, comment));
        }
        return sendError(res, store, 404, 'Not Found');
      }
      return sendError(res, store, 404, 'Not Found');
    }

    // /repos/{o}/{r}/pulls
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (ctx.req.method === 'GET') {
          const state = (query.get('state') ?? 'open').toLowerCase();
          let pulls = [...repo.pulls];
          if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
          pulls.sort((a, b) => b.seq - a.seq);
          const perPage = Math.min(100, parsePositiveInt(query.get('per_page'), 30));
          const page = parsePositiveInt(query.get('page'), 1);
          const pageItems = paginate(pulls, page, perPage);
          return sendJson(res, store, 200, pageItems.map((p) => pullJson(store, repo, p)));
        }
        if (ctx.req.method === 'POST') {
          const body = ctx.json ?? {};
          const title = typeof body.title === 'string' ? body.title : '';
          const head = typeof body.head === 'string' ? body.head : '';
          const base = typeof body.base === 'string' ? body.base : repo.defaultBranch;
          if (title.length === 0 || head.length === 0) return sendError(res, store, 422, 'Validation Failed: title and head are required');
          const created = store.createPull(repo, title, typeof body.body === 'string' ? body.body : '', head, base);
          if ('error' in created) return sendError(res, store, 422, `Validation Failed: ${created.error}`);
          return sendJson(res, store, 201, pullJson(store, repo, created));
        }
        return sendError(res, store, 404, 'Not Found');
      }
      const pullNumber = Number.parseInt(rest[1], 10);
      const pull = repo.pulls.find((p) => p.number === pullNumber);
      if (!pull) return sendError(res, store, 404, 'Not Found');
      if (rest.length === 2 && ctx.req.method === 'GET') {
        return sendJson(res, store, 200, pullJson(store, repo, pull));
      }
      if (rest.length === 3 && rest[2] === 'files' && ctx.req.method === 'GET') {
        const files = store.pullFiles(repo, pull);
        return sendJson(res, store, 200, files.map((f) => ({
          sha: '',
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })));
      }
      if (rest.length === 3 && rest[2] === 'merge' && ctx.req.method === 'PUT') {
        const merged = store.mergePull(repo, pull);
        if ('error' in merged) return sendError(res, store, merged.status, merged.error);
        return sendJson(res, store, 200, { merged: true, sha: merged.sha, message: 'Pull request successfully merged' });
      }
      return sendError(res, store, 404, 'Not Found');
    }

    return sendError(res, store, 404, 'Not Found');
  }

  return sendError(res, store, 404, 'Not Found');
}

function checkAuth(store: Store, req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token.length === 0) return false;
  if (store.token.length > 0 && token !== store.token) return false;
  return true;
}

export function createApp(store: Store): ReturnType<typeof createServer> {
  const server = createServer(async (req, res) => {
    try {
      const rawUrl = req.url ?? '/';
      const qIndex = rawUrl.indexOf('?');
      const rawPath = qIndex >= 0 ? rawUrl.slice(0, qIndex) : rawUrl;
      const queryString = qIndex >= 0 ? rawUrl.slice(qIndex + 1) : '';
      const segments = rawPath.split('/').filter((s) => s.length > 0);
      const host = req.headers.host ?? '127.0.0.1';
      const method = req.method ?? 'GET';

      if (method === 'GET' && rawPath === '/healthz') {
        return sendJson(res, store, 200, { ok: true });
      }

      // Git smart HTTP: /{owner}/{repo}.git/...
      if (segments.length >= 2 && segments[1].endsWith('.git')) {
        const owner = decodeSegment(segments[0]);
        const repoName = decodeSegment(segments[1].slice(0, -4));
        const repo = owner === store.viewer.login ? store.getRepo(owner, repoName) : undefined;
        if (!checkAuth(store, req)) return sendError(res, store, 401, 'Requires authentication');
        const sub = segments.slice(2);
        const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
        if (sub[0] === 'info' && sub[1] === 'refs' && method === 'GET') {
          const service = parseQuery(queryString).get('service') ?? '';
          const gitProtocolHeader = req.headers['git-protocol'];
          const gitProtocol = Array.isArray(gitProtocolHeader) ? (gitProtocolHeader[0] ?? '') : (gitProtocolHeader ?? '');
          const result = handleInfoRefs(store, repo, service, gitProtocol);
          return sendRaw(res, store, result.status, result.contentType, result.body);
        }
        if (sub[0] === 'git-upload-pack' && method === 'POST') {
          const result = handleUploadPack(store, repo, body);
          return sendRaw(res, store, result.status, result.contentType, result.body);
        }
        if (sub[0] === 'git-receive-pack' && method === 'POST') {
          const result = handleReceivePack(store, repo, body);
          return sendRaw(res, store, result.status, result.contentType, result.body);
        }
        return sendError(res, store, 404, 'Not Found');
      }

      // MCP.
      if (segments.length === 1 && segments[0] === 'mcp' && method === 'POST') {
        if (!checkAuth(store, req)) return sendError(res, store, 401, 'Requires authentication');
        const body = await readBody(req);
        const result = handleMcp(store, body, {
          protocolVersion: (req.headers['mcp-protocol-version'] as string | undefined) ?? null,
          method: (req.headers['mcp-method'] as string | undefined) ?? null,
        });
        if (result.body === null) {
          res.writeHead(result.status, { 'X-GitHub-Request-Id': store.nextRequestId() });
          res.end();
          return;
        }
        return sendRaw(res, store, result.status, 'application/json; charset=utf-8', result.body);
      }

      // GraphQL.
      if (segments.length === 2 && segments[0] === 'api' && segments[1] === 'graphql' && method === 'POST') {
        if (!checkAuth(store, req)) return sendError(res, store, 401, 'Requires authentication');
        const body = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(body.toString('utf8'));
        } catch {
          return sendError(res, store, 400, 'Malformed JSON body');
        }
        const documents = Array.isArray(parsed) ? parsed : [parsed];
        const results = documents.map((doc) => {
          const d = (doc ?? {}) as Record<string, unknown>;
          const query = typeof d.query === 'string' ? d.query : '';
          const variables = (d.variables ?? {}) as Record<string, unknown>;
          const operationName = typeof d.operationName === 'string' ? d.operationName : null;
          return executeGraphql(store, query, variables, operationName);
        });
        return sendJson(res, store, 200, Array.isArray(parsed) ? results : results[0]);
      }

      // REST v3.
      if (segments.length >= 1 && segments[0] === 'api' && segments[1] === 'v3') {
        const isRootOrMeta = segments.length === 2 || (segments.length === 3 && segments[2] === 'meta');
        if (!isRootOrMeta && !checkAuth(store, req)) return sendError(res, store, 401, 'Requires authentication');
        let json: Record<string, unknown> | null = null;
        if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
          const body = await readBody(req);
          if (body.length > 0) {
            try {
              const parsed = JSON.parse(body.toString('utf8')) as unknown;
              if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                json = parsed as Record<string, unknown>;
              } else {
                json = {};
              }
            } catch {
              return sendError(res, store, 400, 'Malformed JSON body');
            }
          }
        }
        const ctx: Ctx = {
          store,
          req,
          res,
          segments: segments.slice(2),
          query: parseQuery(queryString),
          body: Buffer.alloc(0),
          json,
          host,
        };
        return handleRest(ctx);
      }

      return sendError(res, store, 404, 'Not Found');
    } catch (error) {
      // Never crash on a bad request: answer 500 JSON and stay alive.
      try {
        sendError(res, store, 500, error instanceof Error ? error.message : 'internal error');
      } catch {
        res.destroy();
      }
    }
  });
  return server;
}
