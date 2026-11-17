// githttp.ts — git smart HTTP: /{owner}/{repo}.git/info/refs and
// /{owner}/{repo}.git/git-upload-pack / git-receive-pack.
// Upload-pack answers protocol v2 (advertisement, ls-refs, fetch);
// receive-pack answers v0 (advertise + push, report-status).

import {
  ZERO_OID,
  buildPack,
  decodePktLines,
  hashObject,
  isAncestor,
  parseCommit,
  parsePack,
  parseTag,
  parseTree,
  peelToCommit,
  pktDelim,
  pktFlush,
  pktLine,
  pktTextLines,
  type GitObject,
} from './git.ts';
import type { Repo, Store } from './store.ts';

export const AGENT = 'github-core-clone-01/1.0';

interface RefInfo {
  name: string;
  oid: string;
  peeled: string | null;
}

export function listRefs(repo: Repo): RefInfo[] {
  const refs: RefInfo[] = [];
  for (const [name, oid] of repo.refs) {
    const obj = repo.objects.get(oid);
    let peeled: string | null = null;
    if (obj && obj.type === 'tag') {
      const commit = peelToCommit(repo.objects, oid);
      if (commit && commit !== oid) peeled = commit;
    }
    refs.push({ name, oid, peeled });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Capabilities advertised for upload-pack v2. */
function v2Capabilities(): string[] {
  return [`agent=${AGENT}`, 'ls-refs=unborn', 'fetch=shallow', 'object-format=sha1'];
}

function v0UploadCaps(repo: Repo): string {
  return `symref=HEAD:${headRefName(repo)} agent=${AGENT} object-format=sha1 side-band-64k ofs-delta thin-pack shallow`;
}

function v0ReceiveCaps(repo: Repo): string {
  return `report-status side-band-64k delete-refs ofs-delta agent=${AGENT} symref=HEAD:${headRefName(repo)} object-format=sha1`;
}

function advertiseV2Upload(): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktLine('version 2\n')];
  for (const cap of v2Capabilities()) parts.push(pktLine(`${cap}\n`));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseV0Upload(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n')];
  const refs = listRefs(repo);
  const mainOid = repo.refs.get(headRefName(repo));
  const caps = v0UploadCaps(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainOid) {
      parts.push(pktLine(`${mainOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      first = false;
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function advertiseV0Receive(repo: Repo): Buffer {
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n')];
  const refs = listRefs(repo);
  const mainOid = repo.refs.get(headRefName(repo));
  const caps = v0ReceiveCaps(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    if (mainOid) {
      parts.push(pktLine(`${mainOid} HEAD\0${caps}\n`));
      first = false;
    }
    for (const ref of refs) {
      const suffix = first ? `\0${caps}` : '';
      parts.push(pktLine(`${ref.oid} ${ref.name}${suffix}\n`));
      first = false;
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ info/refs

export function handleInfoRefs(
  store: Store,
  repo: Repo | undefined,
  service: string,
  gitProtocol: string,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2Upload() };
    }
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0Upload(repo) };
  }
  if (service === 'git-receive-pack') {
    return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0Receive(repo) };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown service' })) };
}

// ------------------------------------------------------------ ls-refs

function handleLsRefs(repo: Repo, args: string[]): Buffer {
  const wantPeel = args.includes('peel');
  const wantSymrefs = args.includes('symrefs');
  const wantUnborn = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const refs = listRefs(repo);
  const mainOid = repo.refs.get(headRefName(repo));
  const lines: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  // HEAD first (only when it matches a prefix, or no prefix given).
  if (mainOid && matches('HEAD')) {
    let line = `${mainOid} HEAD`;
    if (wantSymrefs) line += ` symref-target:${headRefName(repo)}`;
    lines.push(pktLine(`${line}\n`));
  } else if (!mainOid && wantUnborn && matches('HEAD')) {
    lines.push(pktLine(`unborn HEAD symref-target:${headRefName(repo)}\n`));
  }
  for (const ref of refs) {
    if (!matches(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (wantPeel && ref.peeled) line += ` peeled:${ref.peeled}`;
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(pktFlush());
  return Buffer.concat(lines);
}

// ------------------------------------------------------------ fetch

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = 32768;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    const payload = Buffer.concat([Buffer.from([1]), chunk]);
    parts.push(pktLine(payload));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function handleFetch(store: Store, repo: Repo, args: string[]): Buffer {
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  for (const arg of args) {
    if (arg.startsWith('want ')) wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number.parseInt(arg.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) depth = n;
    }
  }
  const parts: Buffer[] = [];
  // Acknowledgments section.
  const { objects, oids, shallow: newShallow, acks, held } = store.fetchObjects(repo, wants, haves, depth, shallow);
  parts.push(pktLine('acknowledgments\n'));
  if (acks.length === 0) {
    parts.push(pktLine('NAK\n'));
  } else {
    for (const ack of acks) parts.push(pktLine(`ACK ${ack}\n`));
    parts.push(pktLine('ready\n'));
  }
  parts.push(pktDelim());
  // Shallow-info section.
  const available = new Set<string>([...oids, ...held]);
  const unshallow = store.computeUnshallow(repo, shallow, available);
  if (newShallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of newShallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  // Packfile section.
  if (objects.length > 0) {
    // Depth-1 packs are cached per (repo, tip) for the clone workload.
    let pack: Buffer | null = null;
    if (depth === 1 && wants.length === 1 && haves.length === 0) {
      const key = `${repo.owner}/${repo.name}@${wants[0]}`;
      pack = store.fetchPackCache.get(key) ?? null;
      if (pack === null) {
        pack = buildPack(objects);
        store.fetchPackCache.set(key, pack);
      }
    }
    if (pack === null) pack = buildPack(objects);
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
  } else {
    parts.push(pktFlush());
  }
  return Buffer.concat(parts);
}

// ------------------------------------------------------------ upload-pack POST

export function handleUploadPack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  let lines: string[];
  try {
    lines = pktTextLines(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad request' })) };
  }
  if (lines.length === 0) {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'empty request' })) };
  }
  const commandLine = lines[0];
  const args = lines.slice(1);
  if (commandLine === 'command=ls-refs') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, args) };
  }
  if (commandLine === 'command=fetch') {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleFetch(store, repo, args) };
  }
  return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'unknown command' })) };
}

// ------------------------------------------------------------ receive-pack POST

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parseReceivePack(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  // pkt-lines until flush, then raw pack bytes.
  let offset = 0;
  const commandLines: string[] = [];
  while (offset + 4 <= body.length) {
    const header = body.subarray(offset, offset + 4).toString('latin1');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length === 1) {
      offset += 4;
      continue;
    }
    if (offset + length > body.length) break;
    const payload = body.subarray(offset + 4, offset + length).toString('utf8');
    commandLines.push(payload);
    offset += length;
  }
  const commands: PushCommand[] = [];
  for (const line of commandLines) {
    const nul = line.indexOf('\0');
    const clean = (nul >= 0 ? line.slice(0, nul) : line).trim();
    const parts = clean.split(' ');
    if (parts.length < 3) continue;
    commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
  }
  return { commands, pack: body.subarray(offset) };
}

export function handleReceivePack(
  store: Store,
  repo: Repo | undefined,
  body: Buffer,
): { status: number; contentType: string; body: Buffer } {
  if (!repo) {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  let parsed: { commands: PushCommand[]; pack: Buffer };
  try {
    parsed = parseReceivePack(body);
  } catch {
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'bad request' })) };
  }
  const { commands, pack } = parsed;
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackError = '';
  // Unpack the pack (always present for create/update, even when empty).
  if (pack.length > 0) {
    try {
      const entries = parsePack(pack);
      for (const entry of entries) {
        const obj: GitObject = { type: entry.type === 1 ? 'commit' : entry.type === 2 ? 'tree' : entry.type === 3 ? 'blob' : 'tag', data: entry.data };
        repo.objects.put(entry.oid, obj);
      }
    } catch (error) {
      unpackOk = false;
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  if (!unpackOk) {
    reportLines.push(`unpack ${unpackError}\n`);
    for (const cmd of commands) reportLines.push(`ng ${cmd.ref} unpack error\n`);
  } else {
    reportLines.push('unpack ok\n');
    for (const cmd of commands) {
      const current = repo.refs.get(cmd.ref);
      if (cmd.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        } else if (cmd.oldOid !== ZERO_OID && cmd.oldOid !== current) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.delete(cmd.ref);
          store.invalidatePackCache();
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      const newObj = repo.objects.get(cmd.newOid);
      if (!newObj) {
        reportLines.push(`ng ${cmd.ref} missing object\n`);
        continue;
      }
      if (cmd.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        } else {
          repo.refs.set(cmd.ref, cmd.newOid);
          store.invalidatePackCache();
          reportLines.push(`ok ${cmd.ref}\n`);
        }
        continue;
      }
      // Update.
      if (current === undefined) {
        reportLines.push(`ng ${cmd.ref} remote ref does not exist\n`);
        continue;
      }
      if (cmd.oldOid !== current) {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
        continue;
      }
      if (cmd.newOid === current) {
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      // Fast-forward check (commits only; tags resolve to their commit).
      const newCommit = peelToCommit(repo.objects, cmd.newOid);
      const oldCommit = peelToCommit(repo.objects, current);
      if (newCommit === null || oldCommit === null) {
        repo.refs.set(cmd.ref, cmd.newOid);
        store.invalidatePackCache();
        reportLines.push(`ok ${cmd.ref}\n`);
        continue;
      }
      if (isAncestor(repo.objects, oldCommit, newCommit)) {
        repo.refs.set(cmd.ref, cmd.newOid);
        store.invalidatePackCache();
        reportLines.push(`ok ${cmd.ref}\n`);
      } else {
        reportLines.push(`ng ${cmd.ref} non-fast-forward\n`);
      }
    }
  }
  // Sideband-framed report: band 1 with inner pkt-lines.
  const inner = Buffer.concat(reportLines.map((line) => pktLine(line)));
  const outer = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush()]);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: outer };
}

export { decodePktLines, parseCommit, parseTag, parseTree, hashObject };
