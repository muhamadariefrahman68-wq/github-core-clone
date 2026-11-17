// store.ts — the in-memory store shared by REST, GraphQL, MCP and git
// smart HTTP. One store per process; the pod is fresh for every trial,
// so no persistence is needed. Everything is deterministic: timestamps
// come from MAKEFUN_TRIAL_NOW and ids/counters are sequential.

import {
  EMPTY_TREE_OID,
  MapObjectStore,
  buildCommit,
  diffTrees,
  flattenTree,
  hashObject,
  isAncestor,
  listDir,
  lookupPath,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  peelToCommit,
  reachableObjects,
  setPathInTree,
  type GitObject,
} from './git.ts';
import { SCENARIO, type ScenarioUser } from './scenario.ts';

export interface RepoLabel {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: RepoLabel[];
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headShaAtCreation: string;
  baseShaAtCreation: string;
  user: ScenarioUser;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  owner: string;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  refs: Map<string, string>;
  objects: MapObjectStore;
  labels: Map<string, RepoLabel>;
  issues: Issue[];
  nextIssueNumber: number;
  pulls: PullRequest[];
  nextPullNumber: number;
  createdSeq: number;
}

export interface CommitRecord {
  sha: string;
  message: string;
  authorName: string;
  authorEmail: string;
  authorDate: string;
  committerName: string;
  committerEmail: string;
  committerDate: string;
  parents: string[];
  tree: string;
}

export function parseTrialNow(value: string | undefined): { ms: number; sec: number; iso: string } {
  let ms: number;
  if (value === undefined || value === '') {
    ms = 1735689600 * 1000;
  } else if (/^\d+$/.test(value)) {
    ms = Number.parseInt(value, 10);
    if (ms < 1_000_000_000_000) ms *= 1000;
  } else {
    const parsed = Date.parse(value);
    ms = Number.isNaN(parsed) ? 1735689600 * 1000 : parsed;
  }
  const sec = Math.floor(ms / 1000);
  return { ms, sec, iso: new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z') };
}

export function gitTimestamp(sec: number, name: string, email: string): string {
  return `${name} <${email}> ${sec} +0000`;
}

function parseIdent(ident: string, fallbackIso: string): { name: string; email: string; date: string } {
  const match = ident.match(/^(.*) <(.*)> (\d+) ([+-]\d{4})$/);
  if (!match) return { name: ident, email: '', date: fallbackIso };
  return {
    name: match[1],
    email: match[2],
    date: new Date(Number.parseInt(match[3], 10) * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

export class Store {
  viewer: ScenarioUser;
  token: string;
  nowMs: number;
  nowSec: number;
  nowIso: string;
  repos = new Map<string, Repo>();
  private nextRepoId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private nextRepoSeq = 1;
  private nextSeq = 1;
  requestCounter = 0;

  // Cache: depth-1 fetch packs keyed by `${owner}/${name}@${tip}`.
  fetchPackCache = new Map<string, Buffer>();

  constructor(token: string, trialNow: string | undefined) {
    this.viewer = SCENARIO.viewer;
    this.token = token;
    const now = parseTrialNow(trialNow);
    this.nowMs = now.ms;
    this.nowSec = now.sec;
    this.nowIso = now.iso;
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  nextSequence(): number {
    this.nextSeq += 1;
    return this.nextSeq;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  listViewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const existing = this.getRepo(this.viewer.login, name);
    if (existing) return existing;
    const repo: Repo = {
      id: this.nextRepoId,
      owner: this.viewer.login,
      name,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      refs: new Map<string, string>(),
      objects: new MapObjectStore(),
      labels: new Map<string, RepoLabel>(),
      issues: [],
      nextIssueNumber: 1,
      pulls: [],
      nextPullNumber: 1,
      createdSeq: this.nextRepoSeq,
    };
    this.nextRepoId += 1;
    this.nextRepoSeq += 1;
    // Seed the empty tree so unborn repos always have a valid tree object.
    repo.objects.put(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
    this.repos.set(this.repoKey(repo.owner, repo.name), repo);
    return repo;
  }

  deleteRepo(repo: Repo): void {
    this.repos.delete(this.repoKey(repo.owner, repo.name));
    this.fetchPackCache.clear();
  }

  invalidatePackCache(): void {
    this.fetchPackCache.clear();
  }

  /** Resolve a branch name / ref / oid to a commit oid, or null. */
  resolveRef(repo: Repo, ref: string): string | null {
    if (/^[0-9a-f]{40}$/.test(ref)) {
      const obj = repo.objects.get(ref);
      if (!obj) return null;
      return peelToCommit(repo.objects, ref);
    }
    const refName = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
    const oid = repo.refs.get(refName);
    if (!oid) return null;
    return peelToCommit(repo.objects, oid);
  }

  branchTip(repo: Repo, branch: string): string | null {
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return null;
    return peelToCommit(repo.objects, oid);
  }

  /** Put a file on a branch; returns the new commit sha and blob sha.
   *  A branch that does not exist yet is created from the default tip
   *  (GitHub behaviour); a repo with no commits starts a root commit. */
  putFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
  ): { commitSha: string; blobSha: string; created: boolean } {
    const { oid: blobSha, object } = hashObject('blob', content);
    repo.objects.put(blobSha, object);
    const segments = path.split('/').filter((s) => s.length > 0);
    let tip = this.branchTip(repo, branch);
    if (tip === null && branch !== repo.defaultBranch) {
      tip = this.branchTip(repo, repo.defaultBranch);
    }
    const baseTreeOid = tip === null ? null : parseCommit(repo.objects.get(tip)!.data).tree;
    const existing = tip === null ? null : lookupPath(repo.objects, baseTreeOid, segments);
    const created = existing === null;
    const treeOid = setPathInTree(repo.objects, baseTreeOid, segments, blobSha, '100644');
    const author = gitTimestamp(this.nowSec, this.viewer.name, this.viewer.email);
    const parents = tip === null ? [] : [tip];
    const commitData = buildCommit({ tree: treeOid, parents, author, committer: author, message });
    const { oid: commitSha, object: commitObj } = hashObject('commit', commitData);
    repo.objects.put(commitSha, commitObj);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.invalidatePackCache();
    return { commitSha, blobSha, created };
  }

  /** Delete a file on a branch; returns the new commit sha (null when absent). */
  deleteFile(repo: Repo, branch: string, path: string, message: string): { commitSha: string } | null {
    const tip = this.branchTip(repo, branch);
    if (tip === null) return null;
    const baseTreeOid = parseCommit(repo.objects.get(tip)!.data).tree;
    const segments = path.split('/').filter((s) => s.length > 0);
    if (lookupPath(repo.objects, baseTreeOid, segments) === null) return null;
    const treeOid = setPathInTree(repo.objects, baseTreeOid, segments, null, '100644');
    const author = gitTimestamp(this.nowSec, this.viewer.name, this.viewer.email);
    const commitData = buildCommit({
      tree: treeOid,
      parents: [tip],
      author,
      committer: author,
      message,
    });
    const { oid: commitSha, object: commitObj } = hashObject('commit', commitData);
    repo.objects.put(commitSha, commitObj);
    repo.refs.set(`refs/heads/${branch}`, commitSha);
    this.invalidatePackCache();
    return { commitSha };
  }

  /** Read a file or directory at a path on a ref. */
  readPath(
    repo: Repo,
    ref: string,
    path: string,
  ):
    | { kind: 'file'; entry: { oid: string; mode: string }; content: Buffer }
    | { kind: 'dir'; entries: Array<{ name: string; path: string; oid: string; mode: string }> }
    | null {
    const commitOid = this.resolveRef(repo, ref);
    if (commitOid === null) return null;
    const commit = parseCommit(repo.objects.get(commitOid)!.data);
    const segments = path.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      const treeObj = repo.objects.get(commit.tree);
      const treeEntries = treeObj ? parseTree(treeObj.data) : [];
      return {
        kind: 'dir',
        entries: treeEntries.map((e) => ({ name: e.name, path: e.name, oid: e.oid, mode: e.mode })),
      };
    }
    const entry = lookupPath(repo.objects, commit.tree, segments);
    if (entry === null) return null;
    if (entry.mode === '40000') {
      const dirEntries = listDir(repo.objects, commit.tree, segments);
      if (dirEntries === null) return null;
      return {
        kind: 'dir',
        entries: dirEntries.map((e) => ({
          name: e.name,
          path: `${segments.join('/')}/${e.name}`,
          oid: e.oid,
          mode: e.mode,
        })),
      };
    }
    const blob = repo.objects.get(entry.oid);
    if (!blob) return null;
    return { kind: 'file', entry, content: blob.data };
  }

  // ------------------------------------------------------------- issues

  createIssue(repo: Repo, title: string, body: string, labelNames: string[]): Issue | { error: string } {
    const labels: RepoLabel[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (!label) return { error: `label "${name}" does not exist` };
      labels.push(label);
    }
    const issue: Issue = {
      id: this.nextIssueId,
      number: repo.nextIssueNumber,
      title,
      body,
      state: 'open',
      labels,
      user: this.viewer,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      seq: this.nextSequence(),
      comments: [],
    };
    this.nextIssueId += 1;
    repo.nextIssueNumber += 1;
    repo.issues.push(issue);
    return issue;
  }

  addComment(repo: Repo, issue: Issue, body: string): IssueComment {
    const comment: IssueComment = {
      id: this.nextCommentId,
      body,
      user: this.viewer,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      seq: this.nextSequence(),
    };
    void repo;
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ------------------------------------------------------------- pulls

  createPull(repo: Repo, title: string, body: string, head: string, base: string): PullRequest | { error: string } {
    const headTip = this.branchTip(repo, head);
    const baseTip = this.branchTip(repo, base);
    if (headTip === null) return { error: `head branch "${head}" does not exist` };
    if (baseTip === null) return { error: `base branch "${base}" does not exist` };
    for (const existing of repo.pulls) {
      if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
        return { error: `a pull request is already open for ${head} into ${base}` };
      }
    }
    const pull: PullRequest = {
      id: this.nextPullId,
      number: repo.nextPullNumber,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef: head,
      baseRef: base,
      headShaAtCreation: headTip,
      baseShaAtCreation: baseTip,
      user: this.viewer,
      createdAt: this.nowIso,
      updatedAt: this.nowIso,
      seq: this.nextSequence(),
    };
    this.nextPullId += 1;
    repo.nextPullNumber += 1;
    repo.pulls.push(pull);
    return pull;
  }

  /** Three-way conflict check for merging `head` into `base`. */
  mergeable(repo: Repo, pull: PullRequest): { mergeable: boolean; conflict: boolean } {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return { mergeable: false, conflict: true };
    if (headTip === baseTip) return { mergeable: true, conflict: false };
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const diffs = diffTrees(repo.objects, baseTree, headTree);
    const oursFiles = flattenTree(repo.objects, oursTree);
    const baseFiles = flattenTree(repo.objects, baseTree);
    for (const diff of diffs) {
      const baseEntry = baseFiles.get(diff.path);
      const oursEntry = oursFiles.get(diff.path);
      const baseOid = baseEntry ? baseEntry.oid : null;
      const oursOid = oursEntry ? oursEntry.oid : null;
      if (baseOid !== oursOid && diff.newOid !== baseOid && diff.newOid !== oursOid) {
        return { mergeable: false, conflict: true };
      }
    }
    return { mergeable: true, conflict: false };
  }

  /** Squash-merge an open PR; returns the merge commit sha or an error. */
  mergePull(repo: Repo, pull: PullRequest): { sha: string } | { error: string; status: number } {
    if (pull.state === 'closed') {
      return { error: 'pull request is already closed', status: 405 };
    }
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) {
      return { error: 'head or base branch is missing', status: 422 };
    }
    const { mergeable } = this.mergeable(repo, pull);
    if (!mergeable) {
      return { error: 'merge conflict', status: 405 };
    }
    const base = mergeBase(repo.objects, headTip, baseTip);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)!.data).tree;
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const oursTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    // Apply the head's changes onto the current base tree.
    const diffs = diffTrees(repo.objects, baseTree, headTree);
    let mergedTree = oursTree;
    for (const diff of diffs) {
      const segments = diff.path.split('/');
      mergedTree = setPathInTree(repo.objects, mergedTree, segments, diff.newOid, '100644');
    }
    const author = gitTimestamp(this.nowSec, this.viewer.name, this.viewer.email);
    const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}\n\n${pull.title}`;
    const commitData = buildCommit({
      tree: mergedTree,
      parents: [baseTip],
      author,
      committer: author,
      message,
    });
    const { oid: mergeSha, object } = hashObject('commit', commitData);
    repo.objects.put(mergeSha, object);
    repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = this.nowIso;
    pull.mergeCommitSha = mergeSha;
    pull.updatedAt = this.nowIso;
    this.invalidatePackCache();
    return { sha: mergeSha };
  }

  /** Files changed between base tip and head tip of a PR. */
  pullFiles(repo: Repo, pull: PullRequest): Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> {
    const headTip = this.branchTip(repo, pull.headRef);
    const baseTip = this.branchTip(repo, pull.baseRef);
    if (headTip === null || baseTip === null) return [];
    const headTree = parseCommit(repo.objects.get(headTip)!.data).tree;
    const baseTree = parseCommit(repo.objects.get(baseTip)!.data).tree;
    const diffs = diffTrees(repo.objects, baseTree, headTree);
    const result: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
    for (const diff of diffs) {
      const linesOf = (oid: string | null): string[] => {
        if (oid === null) return [];
        const obj = repo.objects.get(oid);
        if (!obj) return [];
        const text = obj.data.toString('utf8');
        if (text.length === 0) return [];
        const lines = text.split('\n');
        if (lines[lines.length - 1] === '') lines.pop();
        return lines;
      };
      let additions = 0;
      let deletions = 0;
      if (diff.status === 'added') {
        additions = linesOf(diff.newOid).length;
      } else if (diff.status === 'removed') {
        deletions = linesOf(diff.oldOid).length;
      } else {
        const oldCounts = new Map<string, number>();
        for (const line of linesOf(diff.oldOid)) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
        const newCounts = new Map<string, number>();
        for (const line of linesOf(diff.newOid)) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
        for (const [line, count] of newCounts) {
          const oldCount = oldCounts.get(line) ?? 0;
          if (count > oldCount) additions += count - oldCount;
        }
        for (const [line, count] of oldCounts) {
          const newCount = newCounts.get(line) ?? 0;
          if (count > newCount) deletions += count - newCount;
        }
        if (additions === 0 && deletions === 0) additions = 1;
      }
      result.push({
        filename: diff.path,
        status: diff.status,
        additions,
        deletions,
        changes: additions + deletions,
      });
    }
    return result;
  }

  /** List commits reachable from a ref tip, newest first. */
  listCommits(repo: Repo, ref: string): CommitRecord[] {
    const tip = this.resolveRef(repo, ref);
    if (tip === null) return [];
    const records: CommitRecord[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const info = parseCommit(obj.data);
      const author = parseIdent(info.author, this.nowIso);
      const committer = parseIdent(info.committer, this.nowIso);
      records.push({
        sha: oid,
        message: info.message,
        authorName: author.name,
        authorEmail: author.email,
        authorDate: author.date,
        committerName: committer.name,
        committerEmail: committer.email,
        committerDate: committer.date,
        parents: info.parents,
        tree: info.tree,
      });
      for (const parent of info.parents) queue.push(parent);
    }
    return records;
  }

  // ------------------------------------------------------------- fetch

  /**
   * Reachable objects for a fetch: wants minus haves, depth-limited.
   * `depth` counts commit generations from the wants (1 = wants only).
   * `clientShallow` is the client's shallow boundary: the client holds
   * those commits but not their parents, so they must not be treated
   * as fully held.
   */
  fetchObjects(
    repo: Repo,
    wants: string[],
    haves: string[],
    depth: number | null,
    clientShallow: string[] = [],
  ): { objects: GitObject[]; oids: string[]; shallow: string[]; acks: string[]; held: Set<string> } {
    const boundary = new Set(clientShallow);
    const held = haves.length > 0 ? reachableObjects(repo.objects, haves, null, boundary) : new Set<string>();
    const acks: string[] = [];
    for (const have of haves) {
      if (!repo.objects.get(have)) continue;
      for (const want of wants) {
        const wantCommit = peelToCommit(repo.objects, want);
        if (wantCommit !== null && (have === wantCommit || isAncestor(repo.objects, have, wantCommit))) {
          acks.push(have);
          break;
        }
      }
    }
    // Depth-limited walk from wants.
    const commitDepth = new Map<string, number>();
    const queue: Array<{ oid: string; depth: number }> = wants.map((oid) => ({ oid, depth: 1 }));
    while (queue.length > 0) {
      const { oid, depth: d } = queue.shift()!;
      if (commitDepth.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        commitDepth.set(oid, d);
        if (!commitDepth.has(tag.object)) queue.push({ oid: tag.object, depth: d });
        continue;
      }
      if (obj.type !== 'commit') continue;
      commitDepth.set(oid, d);
      if (depth === null || d < depth) {
        const info = parseCommit(obj.data);
        for (const parent of info.parents) {
          if (!commitDepth.has(parent)) queue.push({ oid: parent, depth: d + 1 });
        }
      }
    }
    // Collect objects reachable from the included commits (full tree closure).
    const allOids = new Set<string>();
    const stack: string[] = [...commitDepth.keys()];
    while (stack.length > 0) {
      const oid = stack.pop()!;
      if (allOids.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      allOids.add(oid);
      if (obj.type === 'commit') {
        const info = parseCommit(obj.data);
        if (!allOids.has(info.tree)) stack.push(info.tree);
      } else if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (!allOids.has(entry.oid)) stack.push(entry.oid);
        }
      } else if (obj.type === 'tag') {
        const tag = parseTag(obj.data);
        if (!allOids.has(tag.object)) stack.push(tag.object);
      }
    }
    // Shallow-info: boundary commits are those at exactly `depth` with parents.
    const shallow: string[] = [];
    if (depth !== null) {
      for (const [oid, d] of commitDepth) {
        if (d !== depth) continue;
        const obj = repo.objects.get(oid);
        if (!obj || obj.type !== 'commit') continue;
        if (parseCommit(obj.data).parents.length > 0) shallow.push(oid);
      }
    }
    const oids: string[] = [];
    const objects: GitObject[] = [];
    for (const oid of allOids) {
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      oids.push(oid);
      objects.push(obj);
    }
    return { objects, oids, shallow, acks, held };
  }

  /** Client boundary commits that stop being shallow after this fetch.
   *  `availableOids` = oids the client will hold after this fetch
   *  (sent ∪ already held). */
  computeUnshallow(repo: Repo, clientShallow: string[], availableOids: Set<string>): string[] {
    const result: string[] = [];
    for (const oid of clientShallow) {
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      const parents = parseCommit(obj.data).parents;
      if (parents.length === 0) {
        result.push(oid);
        continue;
      }
      if (availableOids.has(oid) && parents.every((p) => availableOids.has(p))) result.push(oid);
    }
    return result;
  }
}
