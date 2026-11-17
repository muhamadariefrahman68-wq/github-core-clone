// graphql.ts — a small, self-contained GraphQL executor for the fixed
// document shapes the conformance suite sends (queries, mutations,
// introspection, batched documents). No external dependency; the parser
// handles the subset used: operations, variables, arguments (literals,
// variables, lists, objects, enums), aliases and inline fragments.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import { b64 } from './rest.ts';

// ------------------------------------------------------------------ values

export type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Record<string, GqlValue> };

export interface GqlField {
  alias: string | null;
  name: string;
  args: Record<string, GqlValue>;
  selections: GqlSelection[] | null;
}

export interface GqlFragment {
  typeCondition: string | null;
  selections: GqlSelection[];
}

export type GqlSelection = { kind: 'field'; field: GqlField } | { kind: 'fragment'; fragment: GqlFragment };

export interface GqlOperation {
  kind: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, { defaultValue: GqlValue | null }>;
  selections: GqlSelection[];
}

function tokenize(source: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      tokens.push(ch);
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let out = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          if (esc === 'n') out += '\n';
          else if (esc === 't') out += '\t';
          else if (esc === 'r') out += '\r';
          else out += esc;
          j += 2;
        } else {
          out += source[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch) && (ch !== '-' || /[0-9]/.test(source[i + 1] ?? ''))) {
      let j = i;
      while (j < source.length && /[0-9.]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      tokens.push(source.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${ch} at ${i}`);
  }
  return tokens;
}

class Parser {
  private tokens: string[];
  private pos = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): string | undefined {
    return this.tokens[this.pos];
  }

  private next(): string {
    const token = this.tokens[this.pos];
    this.pos += 1;
    return token;
  }

  private expect(token: string): void {
    const got = this.next();
    if (got !== token) throw new Error(`expected ${token}, got ${got}`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      operations.push(this.parseOperation());
    }
    return operations;
  }

  private parseOperation(): GqlOperation {
    let kind: 'query' | 'mutation' = 'query';
    const token = this.peek();
    if (token === 'query' || token === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') {
      name = this.next();
    }
    const variables: Record<string, { defaultValue: GqlValue | null }> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        this.expect('$');
        const varName = this.next();
        this.expect(':');
        // Type name (possibly [Type]! etc.) — skip until ',' or ')' or '='.
        while (this.peek() !== undefined && this.peek() !== ',' && this.peek() !== ')' && this.peek() !== '=') this.next();
        let defaultValue: GqlValue | null = null;
        if (this.peek() === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables[varName] = { defaultValue };
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek() !== '}') {
      selections.push(this.parseSelection());
    }
    this.expect('}');
    return selections;
  }

  private parseSelection(): GqlSelection {
    if (this.peek() === '...') {
      this.next();
      let typeCondition: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        typeCondition = this.next();
      }
      const selections = this.parseSelectionSet();
      return { kind: 'fragment', fragment: { typeCondition, selections } };
    }
    let alias: string | null = null;
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Record<string, GqlValue> = {};
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args[argName] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selections: GqlSelection[] | null = null;
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { kind: 'field', field: { alias, name, args, selections } };
  }

  parseValue(): GqlValue {
    const token = this.next();
    if (token === '$') return { kind: 'variable', name: this.next() };
    if (token === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (token === '{') {
      const fields: Record<string, GqlValue> = {};
      while (this.peek() !== '}') {
        const key = this.next();
        this.expect(':');
        fields[key] = this.parseValue();
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token === 'true') return { kind: 'boolean', value: true };
    if (token === 'false') return { kind: 'boolean', value: false };
    if (token === 'null') return { kind: 'null' };
    if (token.startsWith('"')) return { kind: 'string', value: JSON.parse(token) as string };
    if (/^-?\d+$/.test(token)) return { kind: 'int', value: Number.parseInt(token, 10) };
    if (/^-?\d+\.\d+$/.test(token)) return { kind: 'float', value: Number.parseFloat(token) };
    return { kind: 'enum', value: token };
  }
}

export function resolveValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'variable': {
      const v = variables[value.name];
      return v === undefined ? null : v;
    }
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, v] of Object.entries(value.fields)) out[key] = resolveValue(v, variables);
      return out;
    }
  }
}

// ------------------------------------------------------------------ schema

const FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url', 'private',
  ],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'updatedAt', 'author', 'comments', 'labels'],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName',
    'headRef', 'baseRef', 'files', 'url', 'createdAt', 'updatedAt', 'author',
  ],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueCommentConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  ChangedFile: ['path'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'description'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
  __Schema: ['types', 'queryType', 'mutationType'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'MARKETPLACE_LISTING'];

// ------------------------------------------------------------------ ids

export function repoGlobalId(repo: Repo): string {
  return b64(`Repository:${repo.owner}/${repo.name}`);
}

export function issueGlobalId(repo: Repo, issue: Issue): string {
  return b64(`Issue:${repo.owner}/${repo.name}:${issue.number}`);
}

export function pullGlobalId(repo: Repo, pull: PullRequest): string {
  return b64(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`);
}

export function decodeGlobalId(id: string): { kind: string; owner: string; name: string; number: number | null } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const firstColon = text.indexOf(':');
    if (firstColon < 0) return null;
    const kind = text.slice(0, firstColon);
    const rest = text.slice(firstColon + 1);
    const lastColon = rest.lastIndexOf(':');
    if (kind === 'Repository') {
      const [owner, name] = rest.split('/');
      if (!owner || !name) return null;
      return { kind, owner, name, number: null };
    }
    if (lastColon < 0) return null;
    const ownerName = rest.slice(0, lastColon);
    const number = Number.parseInt(rest.slice(lastColon + 1), 10);
    const [owner, name] = ownerName.split('/');
    if (!owner || !name || !Number.isFinite(number)) return null;
    return { kind, owner, name, number };
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ values

type Internal =
  | { __type: 'Query' }
  | { __type: 'Mutation' }
  | { __type: 'User'; login: string; id: number; name: string; email: string }
  | { __type: 'Repository'; repo: Repo }
  | { __type: 'Issue'; repo: Repo; issue: Issue }
  | { __type: 'PullRequest'; repo: Repo; pull: PullRequest }
  | { __type: 'IssueConnection'; repo: Repo; issues: Issue[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestConnection'; repo: Repo; pulls: PullRequest[]; hasNextPage: boolean; endCursor: string | null }
  | { __type: 'PullRequestChangedFileConnection'; files: Array<{ path: string }> }
  | { __type: 'ChangedFile'; path: string }
  | { __type: 'IssueCommentConnection'; nodes: Internal[]; pageInfo: Internal; totalCount: number }
  | { __type: 'IssueComment'; repo: Repo; issue: Issue; comment: { id: number; body: string } }
  | { __type: 'IssueCommentEdge'; node: Internal }
  | { __type: 'IssueEdge'; node: Internal }
  | { __type: 'PullRequestEdge'; node: Internal }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'Ref'; name: string }
  | { __type: '__Type'; name: string; kind: string; fields: string[]; enumValues: string[] }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string }
  | { __type: '__Schema' }
  | { __type: 'CreateIssuePayload'; issue: Internal | null }
  | { __type: 'CloseIssuePayload'; issue: Internal | null }
  | { __type: 'CreatePullRequestPayload'; pullRequest: Internal | null }
  | { __type: 'MergePullRequestPayload'; pullRequest: Internal | null }
  | { __type: 'AddCommentPayload'; commentEdge: Internal | null };

interface Ctx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string }>;
}

function cursorFor(number: number): string {
  return b64(`cursor:${number}`);
}

function numberFromCursor(cursor: string | null): number | null {
  if (cursor === null || cursor === undefined) return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

function argValue(field: GqlField, name: string, ctx: Ctx): unknown {
  const raw = field.args[name];
  if (raw === undefined) return undefined;
  return resolveValue(raw, ctx.variables);
}

function repoFromGlobalId(store: Store, id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.kind !== 'Repository') return null;
  return store.getRepo(decoded.owner, decoded.name) ?? null;
}

function resolveField(parent: Internal, field: GqlField, ctx: Ctx): Internal | Internal[] | string | string[] | number | boolean | null {
  const { store } = ctx;
  const typeName = parent.__type;
  switch (typeName) {
    case 'Query': {
      if (field.name === 'viewer') {
        const viewer = store.viewer;
        return { __type: 'User', login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email };
      }
      if (field.name === 'repository') {
        const owner = argValue(field, 'owner', ctx) as string;
        const name = argValue(field, 'name', ctx) as string;
        const repo = store.getRepo(owner, name);
        return repo ? { __type: 'Repository', repo } : null;
      }
      if (field.name === 'node') {
        const id = argValue(field, 'id', ctx) as string;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.kind === 'Repository') {
          const repo = store.getRepo(decoded.owner, decoded.name);
          return repo ? { __type: 'Repository', repo } : null;
        }
        if (decoded.kind === 'Issue' && decoded.number !== null) {
          const repo = store.getRepo(decoded.owner, decoded.name);
          const issue = repo?.issues.find((i) => i.number === decoded.number);
          return repo && issue ? { __type: 'Issue', repo, issue } : null;
        }
        if (decoded.kind === 'PullRequest' && decoded.number !== null) {
          const repo = store.getRepo(decoded.owner, decoded.name);
          const pull = repo?.pulls.find((p) => p.number === decoded.number);
          return repo && pull ? { __type: 'PullRequest', repo, pull } : null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = argValue(field, 'name', ctx) as string;
        if (name === 'Issue') return { __type: '__Type', name, kind: 'OBJECT', fields: FIELDS.Issue, enumValues: [] };
        if (name === 'PullRequest') return { __type: '__Type', name, kind: 'OBJECT', fields: FIELDS.PullRequest, enumValues: [] };
        if (name === 'Repository') return { __type: '__Type', name, kind: 'OBJECT', fields: FIELDS.Repository, enumValues: [] };
        if (name === 'SearchType') return { __type: '__Type', name, kind: 'ENUM', fields: [], enumValues: SEARCH_TYPE_VALUES };
        return null;
      }
      if (field.name === '__schema') return { __type: '__Schema' };
      return null;
    }
    case 'Mutation': {
      if (field.name === 'createIssue') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(store, input.repositoryId);
        if (!repo) return { __type: 'CreateIssuePayload', issue: null };
        const created = store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        if ('error' in created) return { __type: 'CreateIssuePayload', issue: null };
        return { __type: 'CreateIssuePayload', issue: { __type: 'Issue', repo, issue: created } };
      }
      if (field.name === 'closeIssue') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        if (!decoded || decoded.kind !== 'Issue' || decoded.number === null) return { __type: 'CloseIssuePayload', issue: null };
        const repo = store.getRepo(decoded.owner, decoded.name);
        const issue = repo?.issues.find((i) => i.number === decoded.number);
        if (!repo || !issue) return { __type: 'CloseIssuePayload', issue: null };
        issue.state = 'closed';
        issue.updatedAt = store.nowIso;
        return { __type: 'CloseIssuePayload', issue: { __type: 'Issue', repo, issue } };
      }
      if (field.name === 'createPullRequest') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const repo = repoFromGlobalId(store, input.repositoryId);
        if (!repo) return { __type: 'CreatePullRequestPayload', pullRequest: null };
        const created = store.createPull(
          repo,
          String(input.title ?? ''),
          String(input.body ?? ''),
          String(input.headRefName ?? ''),
          String(input.baseRefName ?? ''),
        );
        if ('error' in created) return { __type: 'CreatePullRequestPayload', pullRequest: null };
        return { __type: 'CreatePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull: created } };
      }
      if (field.name === 'mergePullRequest') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        if (!decoded || decoded.kind !== 'PullRequest' || decoded.number === null) return { __type: 'MergePullRequestPayload', pullRequest: null };
        const repo = store.getRepo(decoded.owner, decoded.name);
        const pull = repo?.pulls.find((p) => p.number === decoded.number);
        if (!repo || !pull) return { __type: 'MergePullRequestPayload', pullRequest: null };
        store.mergePull(repo, pull);
        return { __type: 'MergePullRequestPayload', pullRequest: { __type: 'PullRequest', repo, pull } };
      }
      if (field.name === 'addComment') {
        const input = (argValue(field, 'input', ctx) ?? {}) as Record<string, unknown>;
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        if (!decoded || decoded.kind !== 'Issue' || decoded.number === null) return { __type: 'AddCommentPayload', commentEdge: null };
        const repo = store.getRepo(decoded.owner, decoded.name);
        const issue = repo?.issues.find((i) => i.number === decoded.number);
        if (!repo || !issue) return { __type: 'AddCommentPayload', commentEdge: null };
        const comment = store.addComment(repo, issue, String(input.body ?? ''));
        const node: Internal = { __type: 'IssueComment', repo, issue, comment: { id: comment.id, body: comment.body } };
        return { __type: 'AddCommentPayload', commentEdge: { __type: 'IssueCommentEdge', node } };
      }
      return null;
    }
    case 'User': {
      if (field.name === 'login') return parent.login;
      if (field.name === 'id') return b64(`User:${parent.login}`);
      if (field.name === 'name') return parent.name;
      if (field.name === 'email') return parent.email;
      if (field.name === 'avatarUrl') return '';
      return null;
    }
    case 'Repository': {
      const repo = parent.repo;
      if (field.name === 'id') return repoGlobalId(repo);
      if (field.name === 'databaseId') return repo.id;
      if (field.name === 'name') return repo.name;
      if (field.name === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field.name === 'description') return repo.description;
      if (field.name === 'private') return repo.private;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field.name === 'owner') return { __type: 'User', login: repo.owner, id: 1000, name: repo.owner, email: `${repo.owner}@example.invalid` };
      if (field.name === 'defaultBranchRef') {
        const tip = store.branchTip(repo, repo.defaultBranch);
        return tip === null ? null : { __type: 'Ref', name: repo.defaultBranch };
      }
      if (field.name === 'viewerPermission') return 'ADMIN';
      if (field.name === 'hasIssuesEnabled') return true;
      if (field.name === 'issue') {
        const number = argValue(field, 'number', ctx) as number;
        const issue = repo.issues.find((i) => i.number === number);
        return issue ? { __type: 'Issue', repo, issue } : null;
      }
      if (field.name === 'issues') {
        const states = (argValue(field, 'states', ctx) as string[] | undefined) ?? null;
        const orderBy = (argValue(field, 'orderBy', ctx) as Record<string, unknown> | undefined) ?? null;
        const first = (argValue(field, 'first', ctx) as number | undefined) ?? 100;
        const after = (argValue(field, 'after', ctx) as string | null | undefined) ?? null;
        let issues = [...repo.issues];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          issues = issues.filter((i) => wanted.has(i.state));
        }
        const direction = orderBy && String(orderBy.direction ?? 'DESC').toUpperCase() === 'ASC' ? 1 : -1;
        issues.sort((a, b) => (a.seq - b.seq) * direction);
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          const idx = issues.findIndex((i) => i.number === afterNumber);
          if (idx >= 0) issues = issues.slice(idx + 1);
        }
        const page = issues.slice(0, first);
        const hasNextPage = issues.length > first;
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
        return { __type: 'IssueConnection', repo, issues: page, hasNextPage, endCursor };
      }
      if (field.name === 'pullRequest') {
        const number = argValue(field, 'number', ctx) as number;
        const pull = repo.pulls.find((p) => p.number === number);
        return pull ? { __type: 'PullRequest', repo, pull } : null;
      }
      if (field.name === 'pullRequests') {
        const states = (argValue(field, 'states', ctx) as string[] | undefined) ?? null;
        const first = (argValue(field, 'first', ctx) as number | undefined) ?? 100;
        const after = (argValue(field, 'after', ctx) as string | null | undefined) ?? null;
        let pulls = [...repo.pulls];
        if (states) {
          const wanted = new Set(states.map((s) => String(s).toLowerCase()));
          pulls = pulls.filter((p) => wanted.has(p.state));
        }
        pulls.sort((a, b) => b.seq - a.seq);
        const afterNumber = numberFromCursor(after);
        if (afterNumber !== null) {
          const idx = pulls.findIndex((p) => p.number === afterNumber);
          if (idx >= 0) pulls = pulls.slice(idx + 1);
        }
        const page = pulls.slice(0, first);
        const hasNextPage = pulls.length > first;
        const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
        return { __type: 'PullRequestConnection', repo, pulls: page, hasNextPage, endCursor };
      }
      return null;
    }
    case 'Issue': {
      const { repo, issue } = parent;
      if (field.name === 'id') return issueGlobalId(repo, issue);
      if (field.name === 'number') return issue.number;
      if (field.name === 'title') return issue.title;
      if (field.name === 'state') return issue.state.toUpperCase();
      if (field.name === 'body') return issue.body;
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field.name === 'createdAt') return issue.createdAt;
      if (field.name === 'updatedAt') return issue.updatedAt;
      if (field.name === 'author') return { __type: 'User', login: issue.user.login, id: issue.user.id, name: issue.user.name, email: issue.user.email };
      if (field.name === 'labels') return issue.labels.map((l) => l.name);
      if (field.name === 'comments') {
        const nodes: Internal[] = issue.comments.map(
          (c) => ({ __type: 'IssueComment', repo, issue, comment: { id: c.id, body: c.body } }) as Internal,
        );
        return {
          __type: 'IssueCommentConnection',
          nodes,
          pageInfo: { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
          totalCount: issue.comments.length,
        };
      }
      return null;
    }
    case 'PullRequest': {
      const { repo, pull } = parent;
      if (field.name === 'id') return pullGlobalId(repo, pull);
      if (field.name === 'number') return pull.number;
      if (field.name === 'title') return pull.title;
      if (field.name === 'body') return pull.body;
      if (field.name === 'state') return pull.state.toUpperCase();
      if (field.name === 'merged') return pull.merged;
      if (field.name === 'mergeable') {
        const { mergeable } = store.mergeable(repo, pull);
        return mergeable ? 'MERGEABLE' : 'CONFLICTING';
      }
      if (field.name === 'headRefName') return pull.headRef;
      if (field.name === 'baseRefName') return pull.baseRef;
      if (field.name === 'headRef') return { __type: 'Ref', name: pull.headRef };
      if (field.name === 'baseRef') return { __type: 'Ref', name: pull.baseRef };
      if (field.name === 'url') return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
      if (field.name === 'createdAt') return pull.createdAt;
      if (field.name === 'updatedAt') return pull.updatedAt;
      if (field.name === 'author') return { __type: 'User', login: pull.user.login, id: pull.user.id, name: pull.user.name, email: pull.user.email };
      if (field.name === 'files') {
        const files = store.pullFiles(repo, pull).map((f) => ({ path: f.filename }));
        return { __type: 'PullRequestChangedFileConnection', files };
      }
      return null;
    }
    case 'IssueConnection': {
      if (field.name === 'nodes') return parent.issues.map((i) => ({ __type: 'Issue', repo: parent.repo, issue: i }) as Internal);
      if (field.name === 'edges') return parent.issues.map((i) => ({ __type: 'IssueEdge', node: { __type: 'Issue', repo: parent.repo, issue: i } }) as Internal);
      if (field.name === 'totalCount') return parent.issues.length;
      if (field.name === 'pageInfo') {
        return {
          __type: 'PageInfo',
          hasNextPage: parent.hasNextPage,
          hasPreviousPage: false,
          startCursor: parent.issues.length > 0 ? cursorFor(parent.issues[0].number) : null,
          endCursor: parent.endCursor,
        };
      }
      return null;
    }
    case 'PullRequestConnection': {
      if (field.name === 'nodes') return parent.pulls.map((p) => ({ __type: 'PullRequest', repo: parent.repo, pull: p }) as Internal);
      if (field.name === 'edges') return parent.pulls.map((p) => ({ __type: 'PullRequestEdge', node: { __type: 'PullRequest', repo: parent.repo, pull: p } }) as Internal);
      if (field.name === 'totalCount') return parent.pulls.length;
      if (field.name === 'pageInfo') {
        return {
          __type: 'PageInfo',
          hasNextPage: parent.hasNextPage,
          hasPreviousPage: false,
          startCursor: parent.pulls.length > 0 ? cursorFor(parent.pulls[0].number) : null,
          endCursor: parent.endCursor,
        };
      }
      return null;
    }
    case 'PullRequestChangedFileConnection': {
      if (field.name === 'nodes') return parent.files.map((f) => ({ __type: 'ChangedFile', path: f.path }) as unknown as Internal);
      if (field.name === 'edges') return [];
      if (field.name === 'totalCount') return parent.files.length;
      if (field.name === 'pageInfo') {
        return { __type: 'PageInfo', hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null };
      }
      return null;
    }
    case 'IssueCommentConnection': {
      if (field.name === 'nodes') return parent.nodes;
      if (field.name === 'edges') return [];
      if (field.name === 'totalCount') return parent.totalCount;
      if (field.name === 'pageInfo') return parent.pageInfo;
      return null;
    }
    case 'ChangedFile': {
      if (field.name === 'path') return parent.path;
      return null;
    }
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'IssueCommentEdge': {
      if (field.name === 'node') return parent.node;
      if (field.name === 'cursor') return '';
      return null;
    }
    case 'PageInfo': {
      if (field.name === 'hasNextPage') return parent.hasNextPage;
      if (field.name === 'hasPreviousPage') return parent.hasPreviousPage;
      if (field.name === 'startCursor') return parent.startCursor;
      if (field.name === 'endCursor') return parent.endCursor;
      return null;
    }
    case 'Ref': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'target') return null;
      return null;
    }
    case 'IssueComment': {
      if (field.name === 'id') return b64(`IssueComment:${parent.repo.owner}/${parent.repo.name}:${parent.issue.number}:${parent.comment.id}`);
      if (field.name === 'body') return parent.comment.body;
      if (field.name === 'author') return { __type: 'User', login: parent.issue.user.login, id: parent.issue.user.id, name: parent.issue.user.name, email: parent.issue.user.email };
      if (field.name === 'createdAt') return parent.issue.createdAt;
      if (field.name === 'updatedAt') return parent.issue.updatedAt;
      return null;
    }
    case '__Type': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'kind') return parent.kind;
      if (field.name === 'description') return null;
      if (field.name === 'fields') return parent.fields.map((f) => ({ __type: '__Field', name: f }) as Internal);
      if (field.name === 'enumValues') return parent.enumValues.map((v) => ({ __type: '__EnumValue', name: v }) as Internal);
      return null;
    }
    case '__Field': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      if (field.name === 'type') return null;
      return null;
    }
    case '__EnumValue': {
      if (field.name === 'name') return parent.name;
      if (field.name === 'description') return null;
      return null;
    }
    case '__Schema': {
      if (field.name === 'types') return [];
      if (field.name === 'queryType') return { __type: '__Type', name: 'Query', kind: 'OBJECT', fields: FIELDS.Query, enumValues: [] };
      if (field.name === 'mutationType') return { __type: '__Type', name: 'Mutation', kind: 'OBJECT', fields: FIELDS.Mutation, enumValues: [] };
      return null;
    }
    case 'CreateIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'CloseIssuePayload': {
      if (field.name === 'issue') return parent.issue;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'CreatePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'MergePullRequestPayload': {
      if (field.name === 'pullRequest') return parent.pullRequest;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    case 'AddCommentPayload': {
      if (field.name === 'commentEdge') return parent.commentEdge;
      if (field.name === 'clientMutationId') return null;
      return null;
    }
    default:
      return null;
  }
}

function isInternal(value: unknown): value is Internal {
  return typeof value === 'object' && value !== null && '__type' in (value as Record<string, unknown>);
}

function executeSelections(
  selections: GqlSelection[],
  parent: Internal,
  ctx: Ctx,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const parentType = parent.__type;
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.fragment.typeCondition === null || selection.fragment.typeCondition === parentType) {
        const nested = executeSelections(selection.fragment.selections, parent, ctx);
        Object.assign(out, nested);
      }
      continue;
    }
    const field = selection.field;
    const responseKey = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[responseKey] = parentType;
      continue;
    }
    const known = FIELDS[parentType] ?? [];
    if (!known.includes(field.name)) {
      ctx.errors.push({ message: `Cannot query field "${field.name}" on type "${parentType}".` });
      continue;
    }
    const value = resolveField(parent, field, ctx);
    if (value === null || value === undefined) {
      out[responseKey] = null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (isInternal(item)) {
          return field.selections ? executeSelections(field.selections, item, ctx) : null;
        }
        return item;
      });
      continue;
    }
    if (isInternal(value)) {
      out[responseKey] = field.selections ? executeSelections(field.selections, value, ctx) : null;
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

export interface GraphqlResult {
  data: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphql(
  store: Store,
  query: string,
  variables: Record<string, unknown>,
  operationName: string | null,
): GraphqlResult {
  let operations: GqlOperation[];
  try {
    operations = new Parser(query).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : 'parse error' }] };
  }
  let operation: GqlOperation | undefined;
  if (operationName) {
    operation = operations.find((op) => op.name === operationName);
  }
  if (!operation) operation = operations[0];
  if (!operation) return { data: null, errors: [{ message: 'empty document' }] };
  // Apply variable defaults.
  const mergedVariables: Record<string, unknown> = { ...variables };
  for (const [name, def] of Object.entries(operation.variables)) {
    if (mergedVariables[name] === undefined && def.defaultValue !== null) {
      mergedVariables[name] = resolveValue(def.defaultValue, mergedVariables);
    }
  }
  const ctx: Ctx = { store, variables: mergedVariables, errors: [] };
  const root: Internal = operation.kind === 'mutation' ? { __type: 'Mutation' } : { __type: 'Query' };
  const data = executeSelections(operation.selections, root, ctx);
  if (ctx.errors.length > 0) {
    return { data: null, errors: ctx.errors };
  }
  return { data };
}
