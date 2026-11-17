// rest.ts — GitHub REST API v3 handlers (/api/v3).
// Serializers produce the shapes the conformance checks assert; extra
// properties are allowed, so responses stay GitHub-like throughout.

import type { Issue, PullRequest, Repo, Store } from './store.ts';

export interface ApiError {
  message: string;
}

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const base = store.viewer.login;
  return {
    id: repo.id,
    node_id: b64(`Repository:${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/repos/${repo.owner}/${repo.name}`,
    created_at: store.nowIso,
    updated_at: store.nowIso,
    pushed_at: store.nowIso,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    visibility: repo.private ? 'private' : 'public',
  };
}

export function b64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: b64(`Issue:${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => ({ id: l.name, name: l.name, color: l.color, description: '' })),
    user: { login: issue.user.login, id: issue.user.id, type: 'User' },
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(store: Store, repo: Repo, issue: Issue, comment: { id: number; body: string; user: { login: string; id: number }; createdAt: string; updatedAt: string }): Record<string, unknown> {
  void store;
  return {
    id: comment.id,
    node_id: b64(`IssueComment:${repo.owner}/${repo.name}:${issue.number}:${comment.id}`),
    body: comment.body,
    user: { login: comment.user.login, id: comment.user.id, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(store: Store, repo: Repo, pull: PullRequest): Record<string, unknown> {
  const headSha = store.branchTip(repo, pull.headRef) ?? pull.headShaAtCreation;
  const baseSha = store.branchTip(repo, pull.baseRef) ?? pull.baseShaAtCreation;
  const { mergeable } = store.mergeable(repo, pull);
  return {
    id: pull.id,
    node_id: b64(`PullRequest:${repo.owner}/${repo.name}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    mergeable,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.user.login, id: pull.user.id, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

export function parsePositiveInt(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Build a GitHub-style Link header for paginated lists. */
export function linkHeader(baseUrl: string, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  const parts: string[] = [];
  if (page < totalPages) parts.push(`<${baseUrl}?per_page=${perPage}&page=${page + 1}>; rel="next"`);
  if (totalPages > 1) parts.push(`<${baseUrl}?per_page=${perPage}&page=${totalPages}>; rel="last"`);
  if (page > 1) parts.push(`<${baseUrl}?per_page=${perPage}&page=1>; rel="first"`);
  if (page > 1) parts.push(`<${baseUrl}?per_page=${perPage}&page=${page - 1}>; rel="prev"`);
  return parts.join(', ');
}

export function paginate<T>(items: T[], page: number, perPage: number): T[] {
  const start = (page - 1) * perPage;
  return items.slice(start, start + perPage);
}
