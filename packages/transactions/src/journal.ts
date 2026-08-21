import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export type JournalState =
  | 'Planned' | 'Preflight' | 'Rejected' | 'Cancelled' | 'Checkpointed'
  | 'Running' | 'Paused' | 'Verifying' | 'Committed' | 'RollingBack'
  | 'RolledBack' | 'NeedsAttention';

export type JournalDetail =
  | { readonly kind: 'reason'; readonly reasonCode: 'stale-plan' | 'preflight-failed' | 'checkpoint-failed' | 'provider-threw' | 'unknown-result' | 'postcondition' | 'reconciliation-failed' | 'rollback-failed' | 'cas-failed' | 'hook-failed' | 'auth-cancelled' | 'cancelled-before-run' }
  | { readonly kind: 'paused'; readonly operationKind: 'merge' | 'rebase' | 'cherryPick' | 'revert' | 'pullMerge' | 'pullRebase' | 'stashApply'; readonly step: number }
  | { readonly kind: 'effects'; readonly refCount: number; readonly pathCount: number; readonly effectsDigest: string };

export interface JournalRecord {
  readonly schema: 1;
  readonly operationId: string;
  readonly state: JournalState;
  readonly sequence: number;
  readonly repositoryId: string;
  readonly planDigest: string;
  readonly updatedAt: string;
  readonly detail?: JournalDetail;
}

const maxRecordBytes = 64 * 1024;

const legalEdges: Readonly<Record<JournalState, readonly JournalState[]>> = {
  Planned: ['Preflight', 'Cancelled'],
  Preflight: ['Rejected', 'Cancelled', 'Checkpointed'],
  Rejected: [],
  Cancelled: [],
  Checkpointed: ['Running', 'Cancelled'],
  Running: ['Paused', 'Verifying'],
  Paused: [],
  Verifying: ['Committed', 'RollingBack', 'NeedsAttention'],
  Committed: [],
  RollingBack: ['RolledBack', 'NeedsAttention'],
  RolledBack: [],
  NeedsAttention: [],
};

/** Terminal outcomes never move again; every other move must be a legal edge. */
export function canTransition(from: JournalState, to: JournalState): boolean {
  return legalEdges[from].includes(to);
}

function validateRecord(record: JournalRecord, previous?: JournalRecord): void {
  if (!Number.isInteger(record.sequence) || record.sequence < 0) throw new Error('invalid journal sequence');
  if (previous && record.sequence !== previous.sequence + 1) throw new Error('journal sequence must advance by exactly one');
  if (previous && !canTransition(previous.state, record.state)) throw new Error(`illegal journal transition ${previous.state} -> ${record.state}`);
  const body = JSON.stringify(record);
  if (Buffer.byteLength(body, 'utf8') > maxRecordBytes) throw new Error('journal record exceeds 64 KiB');
}

/**
 * Append-only, checksummed journal. Records are flushed to a temporary file,
 * fsynced, then published with a same-directory hard link so a crash at any
 * point leaves either the previous complete record or the new one — never a
 * half-written JSON body.
 */
export class DurableJournal {
  constructor(private readonly root: string) {}

  async append(record: JournalRecord, previous?: JournalRecord): Promise<void> {
    validateRecord(record, previous);
    const repositorySegment = createHash('sha256').update(record.repositoryId).digest('hex');
    const operationSegment = createHash('sha256').update(record.operationId).digest('hex');
    const directory = join(this.root, repositorySegment, operationSegment);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const body = JSON.stringify(record);
    const envelope = JSON.stringify({ checksum: createHash('sha256').update(body).digest('hex'), body });
    const payload = `${envelope}\n`;
    const target = join(directory, `${String(record.sequence).padStart(6, '0')}.json`);
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, 'wx', 0o600);
    try {
      try {
        await file.writeFile(payload);
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(target, 'utf8') !== payload) throw error;
      }
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
    await syncDirectoryIfSupported(dirname(target));
  }

  async readAll(repositoryId: string, operationId: string): Promise<readonly JournalRecord[]> {
    const repositorySegment = createHash('sha256').update(repositoryId).digest('hex');
    const operationSegment = createHash('sha256').update(operationId).digest('hex');
    const directory = join(this.root, repositorySegment, operationSegment);
    const { readdir } = await import('node:fs/promises');
    let names: string[];
    try {
      names = await readdir(directory);
    } catch {
      return [];
    }
    const records: JournalRecord[] = [];
    for (const name of names.filter((candidate) => candidate.endsWith('.json')).sort()) {
      const payload = await readFile(join(directory, name), 'utf8');
      const envelope = JSON.parse(payload) as { checksum: string; body: string };
      if (createHash('sha256').update(envelope.body).digest('hex') !== envelope.checksum) throw new Error(`journal record ${name} failed checksum`);
      records.push(JSON.parse(envelope.body) as JournalRecord);
    }
    return records;
  }
}

async function syncDirectoryIfSupported(directory: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (!code || !['EINVAL', 'ENOTSUP', 'EISDIR', 'EPERM', 'EACCES', 'EBADF'].includes(code)) throw error;
  } finally {
    await handle?.close();
  }
}
