// git.ts — a from-scratch git implementation (stdlib only).
// Objects (blob/tree/commit/tag), SHA-1, packfile read/write (plain
// objects, no deltas — the client never sends deltas), pkt-lines,
// reachability, tree manipulation, merge-base and fast-forward checks.

import { createHash } from 'node:crypto';
import { inflateSync, deflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function hashObject(type: string, body: Buffer): { oid: string; object: GitObject } {
  const header = Buffer.from(`${type} ${body.length}\0`, 'latin1');
  const raw = Buffer.concat([header, body]);
  return { oid: sha1Hex(raw), object: { type, data: body } };
}

export interface GitObject {
  type: string; // 'blob' | 'tree' | 'commit' | 'tag'
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('latin1');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${info.message}`, 'utf8');
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split >= 0 ? text.slice(0, split) : text;
  const message = split >= 0 ? text.slice(split + 2) : '';
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string | Buffer): Buffer {
  const payload = typeof text === 'string' ? Buffer.from(text, 'utf8') : text;
  const size = payload.length + 4;
  if (size > 65520) throw new Error('pkt-line too large');
  const prefix = Buffer.from(size.toString(16).padStart(4, '0'), 'latin1');
  return Buffer.concat([prefix, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'latin1');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'latin1');
}

/** Decode a pkt-line stream into frames: {kind:'data'|'flush'|'delim', payload?}. */
export function decodePktLines(data: Buffer): Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> {
  const frames: Array<{ kind: 'data' | 'flush' | 'delim'; payload: Buffer }> = [];
  let offset = 0;
  while (offset + 4 <= data.length) {
    const header = data.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      frames.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      frames.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (offset + length > data.length) break;
    frames.push({ kind: 'data', payload: data.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return frames;
}

/** Split a buffer of pkt-line framed text into lines (without trailing \n). */
export function pktTextLines(data: Buffer): string[] {
  const lines: string[] = [];
  for (const frame of decodePktLines(data)) {
    if (frame.kind === 'data') {
      const text = frame.payload.toString('utf8');
      for (const part of text.split('\n')) {
        if (part.length > 0) lines.push(part);
      }
    }
  }
  return lines;
}

// ---------------------------------------------------------------- packs

export interface PackEntry {
  type: number; // 1 commit, 2 tree, 3 blob, 4 tag
  oid: string;
  data: Buffer;
}

const PACK_TYPE_NAMES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function parsePack(data: Buffer): PackEntry[] {
  if (data.length < 12) throw new Error('pack too short');
  if (data.subarray(0, 4).toString('latin1') !== 'PACK') throw new Error('not a packfile');
  const version = data.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = data.readUInt32BE(8);
  const entries: PackEntry[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    let first = data[offset];
    offset += 1;
    const type = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    while ((first & 0x80) !== 0) {
      first = data[offset];
      offset += 1;
      size |= (first & 0x7f) << shift;
      shift += 7;
    }
    if (type === 6) {
      // OFS_DELTA — not produced by the client; unsupported.
      throw new Error('ofs-delta pack entries are not supported');
    }
    if (type === 7) {
      // REF_DELTA — not produced by the client; unsupported.
      throw new Error('ref-delta pack entries are not supported');
    }
    const typeName = PACK_TYPE_NAMES[type];
    if (!typeName) throw new Error(`unknown pack object type ${type}`);
    // One inflate per object: {info:true} reports the compressed bytes
    // consumed (engine.bytesWritten), so no probing is needed.
    const { buffer: inflated, engine } = inflateSync(data.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (inflated.length !== size) throw new Error('pack entry size mismatch');
    offset += engine.bytesWritten;
    const header = Buffer.from(`${typeName} ${inflated.length}\0`, 'latin1');
    const oid = sha1Hex(Buffer.concat([header, inflated]));
    entries.push({ type, oid, data: inflated });
  }
  return entries;
}

export function buildPack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'latin1');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  const typeNumbers: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  for (const obj of objects) {
    const typeNum = typeNumbers[obj.type];
    if (typeNum === undefined) throw new Error(`cannot pack object type ${obj.type}`);
    const compressed = deflateSync(obj.data);
    // Variable-length size header: low 4 bits first, then 7-bit groups.
    const size = obj.data.length;
    const sizeBytes: number[] = [];
    let remaining = size;
    let firstByte = (typeNum << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) firstByte |= 0x80;
    sizeBytes.push(firstByte);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      sizeBytes.push(byte);
    }
    parts.push(Buffer.from(sizeBytes));
    parts.push(compressed);
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------- store

export interface ObjectStore {
  get(oid: string): GitObject | undefined;
  has(oid: string): boolean;
  put(oid: string, obj: GitObject): void;
}

export class MapObjectStore implements ObjectStore {
  private map = new Map<string, GitObject>();
  get(oid: string): GitObject | undefined {
    return this.map.get(oid);
  }
  has(oid: string): boolean {
    return this.map.has(oid);
  }
  put(oid: string, obj: GitObject): void {
    this.map.set(oid, obj);
  }
  get size(): number {
    return this.map.size;
  }
}

// ---------------------------------------------------------------- reachability

/** Walk commits from `tips` (depth-limited: depth 1 = tips only).
 *  Commits in `boundary` (a shallow client's boundary) contribute
 *  themselves but their parents are not walked. */
export function walkCommits(
  store: ObjectStore,
  tips: string[],
  maxDepth: number | null,
  boundary: Set<string> | null = null,
): Set<string> {
  const seen = new Set<string>();
  const queue: Array<{ oid: string; depth: number }> = tips.map((oid) => ({ oid, depth: 1 }));
  while (queue.length > 0) {
    const { oid, depth } = queue.shift()!;
    if (seen.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (!seen.has(tag.object)) queue.push({ oid: tag.object, depth });
      seen.add(oid);
      continue;
    }
    if (obj.type !== 'commit') continue;
    seen.add(oid);
    if (boundary !== null && boundary.has(oid)) continue;
    if (maxDepth !== null && depth >= maxDepth) continue;
    const commit = parseCommit(obj.data);
    for (const parent of commit.parents) {
      if (!seen.has(parent)) queue.push({ oid: parent, depth: depth + 1 });
    }
  }
  return seen;
}

/** Resolve a ref target oid to a commit oid (peeling tags). */
export function peelToCommit(store: ObjectStore, oid: string): string | null {
  let current = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = store.get(current);
    if (!obj) return null;
    if (obj.type === 'commit') return current;
    if (obj.type === 'tag') {
      current = parseTag(obj.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** All objects reachable from `tips` (commits + their trees/blobs, tags).
 *  `boundary` stops the commit walk at those commits (a shallow client's
 *  boundary: it holds the commit but not its parents). */
export function reachableObjects(store: ObjectStore, tips: string[], maxDepth: number | null, boundary: Set<string> | null = null): Set<string> {
  const result = new Set<string>();
  const commits = walkCommits(store, tips, maxDepth, boundary);
  const stack: string[] = [...commits, ...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (result.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj) continue;
    result.add(oid);
    if (obj.type === 'commit') {
      const commit = parseCommit(obj.data);
      if (!result.has(commit.tree)) stack.push(commit.tree);
    } else if (obj.type === 'tree') {
      for (const entry of parseTree(obj.data)) {
        if (!result.has(entry.oid)) stack.push(entry.oid);
      }
    } else if (obj.type === 'tag') {
      const tag = parseTag(obj.data);
      if (!result.has(tag.object)) stack.push(tag.object);
    }
  }
  return result;
}

/** Ancestors of a commit (including itself), as a set. */
export function ancestorSet(store: ObjectStore, tip: string): Set<string> {
  const result = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (result.has(oid)) continue;
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    result.add(oid);
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return result;
}

/** True when `ancestor` is an ancestor of (or equal to) `descendant`. */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const stack = [descendant];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) stack.push(parent);
  }
  return false;
}

/** Merge-base: first commit reachable from both tips (BFS from `b` into `a`'s ancestors). */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = ancestorSet(store, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift()!;
    if (ancestorsA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = store.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return null;
}

// ---------------------------------------------------------------- trees

/** Look up a path (segments) in a tree; returns the entry or null. */
export function lookupPath(store: ObjectStore, rootTreeOid: string | null, segments: string[]): TreeEntry | null {
  if (rootTreeOid === null) return null;
  let treeOid: string | null = rootTreeOid;
  for (let i = 0; i < segments.length; i += 1) {
    if (treeOid === null) return null;
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return null;
    const entries = parseTree(obj.data);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry) return null;
    if (i === segments.length - 1) return entry;
    if (entry.mode === '40000') {
      treeOid = entry.oid;
    } else {
      return null;
    }
  }
  return null;
}

/** List entries of a directory (segments) in a tree; null if not a tree. */
export function listDir(store: ObjectStore, rootTreeOid: string | null, segments: string[]): TreeEntry[] | null {
  if (rootTreeOid === null) return segments.length === 0 ? [] : null;
  let treeOid: string | null = rootTreeOid;
  for (const segment of segments) {
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === segment);
    if (!entry || entry.mode !== '40000') return null;
    treeOid = entry.oid;
  }
  const obj = store.get(treeOid);
  if (!obj || obj.type !== 'tree') return null;
  return parseTree(obj.data);
}

/**
 * Return a new root tree oid with `segments` set to `blobOid` (or deleted
 * when blobOid is null). Intermediate trees are created as needed and
 * stored in `store` (which must also contain the new blob already).
 */
export function setPathInTree(
  store: ObjectStore,
  rootTreeOid: string | null,
  segments: string[],
  blobOid: string | null,
  mode: string,
): string {
  if (segments.length === 0) throw new Error('empty path');
  const [head, ...rest] = segments;
  let entries: TreeEntry[] = [];
  if (rootTreeOid !== null) {
    const obj = store.get(rootTreeOid);
    if (obj && obj.type === 'tree') entries = parseTree(obj.data);
  }
  const idx = entries.findIndex((e) => e.name === head);
  if (rest.length === 0) {
    if (blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode, name: head, oid: blobOid };
    } else {
      entries.push({ mode, name: head, oid: blobOid });
    }
  } else {
    const childTree = idx >= 0 && entries[idx].mode === '40000' ? entries[idx].oid : null;
    const newChild = setPathInTree(store, childTree, rest, blobOid, mode);
    // If the subtree ended up empty, drop the directory entry.
    const childObj = store.get(newChild);
    const childEntries = childObj && childObj.type === 'tree' ? parseTree(childObj.data) : [];
    if (childEntries.length === 0 && blobOid === null) {
      if (idx >= 0) entries.splice(idx, 1);
    } else if (idx >= 0) {
      entries[idx] = { mode: '40000', name: head, oid: newChild };
    } else {
      entries.push({ mode: '40000', name: head, oid: newChild });
    }
  }
  const data = buildTree(entries);
  const { oid, object } = hashObject('tree', data);
  store.put(oid, object);
  return oid;
}

/** Collect every file path in a tree: path -> {oid, mode}. */
export function flattenTree(store: ObjectStore, rootTreeOid: string | null, prefix = ''): Map<string, { oid: string; mode: string }> {
  const result = new Map<string, { oid: string; mode: string }>();
  if (rootTreeOid === null) return result;
  const walk = (treeOid: string, base: string): void => {
    const obj = store.get(treeOid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = base === '' ? entry.name : `${base}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else result.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(rootTreeOid, prefix);
  return result;
}

/** Empty tree oid (stable). */
export const EMPTY_TREE_OID = (() => {
  const { oid } = hashObject('tree', Buffer.alloc(0));
  return oid;
})();

/** Diff two trees; returns changed paths with old/new blob oids. */
export function diffTrees(
  store: ObjectStore,
  oldTreeOid: string | null,
  newTreeOid: string | null,
): Array<{ path: string; oldOid: string | null; newOid: string | null; status: 'added' | 'removed' | 'modified' }> {
  const oldFiles = flattenTree(store, oldTreeOid);
  const newFiles = flattenTree(store, newTreeOid);
  const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
  const result: Array<{ path: string; oldOid: string | null; newOid: string | null; status: 'added' | 'removed' | 'modified' }> = [];
  for (const path of [...paths].sort()) {
    const oldEntry = oldFiles.get(path);
    const newEntry = newFiles.get(path);
    if (oldEntry && !newEntry) result.push({ path, oldOid: oldEntry.oid, newOid: null, status: 'removed' });
    else if (!oldEntry && newEntry) result.push({ path, oldOid: null, newOid: newEntry.oid, status: 'added' });
    else if (oldEntry && newEntry && oldEntry.oid !== newEntry.oid) result.push({ path, oldOid: oldEntry.oid, newOid: newEntry.oid, status: 'modified' });
  }
  return result;
}
