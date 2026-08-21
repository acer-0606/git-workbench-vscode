import {
  GitWorkbenchError,
  asObjectId,
  asRepoRelativePath,
  type ChangeKind,
  type ObjectId,
  type RepositoryStatus,
  type WorkingTreeChange,
} from '@git-workbench/domain';

export interface StatusV2Diagnostic {
  readonly code: 'UNKNOWN_HEADER' | 'UNKNOWN_RECORD';
}

export const statusV2Limits = Object.freeze({
  maxTotalBytes: 4 * 1024 * 1024,
  maxRecordBytes: 1024 * 1024,
  maxRecords: 10_000,
  maxChanges: 10_000,
  maxDiagnostics: 256,
});

const unsupportedStatus = (): GitWorkbenchError => new GitWorkbenchError({
  code: 'PARSER_UNSUPPORTED',
  message: 'Unsupported Git status output.',
  repositoryChanged: false,
  retry: 'none',
});

const statusTooLarge = (): GitWorkbenchError => new GitWorkbenchError({
  code: 'TOO_LARGE',
  message: 'Git status output exceeds parser limits.',
  repositoryChanged: false,
  retry: 'none',
});

const ordinaryStatusKinds: Readonly<Record<string, ChangeKind | 'unchanged'>> = {
  '.': 'unchanged',
  M: 'modified',
  T: 'modified',
  A: 'added',
  D: 'deleted',
};

const renameCopyStatusKinds: Readonly<Record<'R' | 'C', ChangeKind>> = {
  R: 'renamed',
  C: 'copied',
};

const unmergedXy = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

const isSafeCount = (value: string): boolean => /^\d+$/.test(value)
  && Number.isSafeInteger(Number(value));

const fieldsAndPath = (record: string, fieldCount: number): readonly [readonly string[], string] | undefined => {
  const fields: string[] = [];
  let start = 0;
  for (let field = 0; field < fieldCount; field += 1) {
    const end = record.indexOf(' ', start);
    if (end < 0) return undefined;
    const value = record.slice(start, end);
    if (value.length === 0) return undefined;
    fields.push(value);
    start = end + 1;
  }
  return [fields, record.slice(start)];
};

const parseOrdinaryXY = (value: string): readonly [ChangeKind | 'unchanged', ChangeKind | 'unchanged'] | undefined => {
  if (!/^(?:\.[AMTD]|[MTA][.MTD]|D\.)$/.test(value)) return undefined;
  return [ordinaryStatusKinds[value[0]!]!, ordinaryStatusKinds[value[1]!]!];
};

const parseRenameCopyXY = (value: string): readonly [ChangeKind, ChangeKind | 'unchanged'] | undefined => {
  const match = /^([RC])([.MTD])$/.exec(value);
  if (match === null) return undefined;
  return [renameCopyStatusKinds[match[1] as 'R' | 'C'], ordinaryStatusKinds[match[2]!]!];
};

const isSubmodule = (value: string): boolean | undefined => {
  if (value === 'N...') return false;
  if (/^S[CM.][M.][U.]$/.test(value)) return true;
  return undefined;
};

const parsePath = (value: string) => asRepoRelativePath(value);

export class StatusV2Decoder {
  private readonly mutableDiagnostics: StatusV2Diagnostic[] = [];
  readonly diagnostics: readonly StatusV2Diagnostic[] = this.mutableDiagnostics;

  private readonly changes: WorkingTreeChange[] = [];
  private readonly branch: {
    headName?: string;
    headOid?: ObjectId;
    upstream?: string;
    ahead: number;
    behind: number;
  } = { ahead: 0, behind: 0 };
  private buffered = new Uint8Array();
  private bufferedLength = 0;
  private pendingRename: Omit<WorkingTreeChange, 'originalPath'> | undefined;
  private finished = false;
  private failed = false;
  private totalBytes = 0;
  private recordCount = 0;

  constructor(private readonly generation: number) {
    if (!Number.isSafeInteger(generation) || generation < 0) {
      throw unsupportedStatus();
    }
  }

  push(chunk: Uint8Array): void {
    this.assertActive();
    try {
      if (!(chunk instanceof Uint8Array)) this.fail();
      if (chunk.length > statusV2Limits.maxTotalBytes - this.totalBytes) this.tooLarge();
      this.totalBytes += chunk.length;

      let start = 0;
      while (start < chunk.length) {
        const terminator = chunk.indexOf(0, start);
        if (terminator < 0) {
          this.appendPartial(chunk.subarray(start));
          return;
        }
        this.completeRecord(chunk.subarray(start, terminator));
        start = terminator + 1;
      }
    } catch (error) {
      if (error instanceof GitWorkbenchError) throw error;
      this.fail();
    }
  }

  finish(): RepositoryStatus {
    this.assertActive();
    if (this.bufferedLength !== 0 || this.pendingRename !== undefined) this.fail();
    this.finished = true;
    return {
      generation: this.generation,
      branch: { ...this.branch },
      changes: [...this.changes],
    };
  }

  private assertActive(): void {
    if (this.finished || this.failed) throw unsupportedStatus();
  }

  private fail(): never {
    this.failed = true;
    throw unsupportedStatus();
  }

  private tooLarge(): never {
    this.failed = true;
    throw statusTooLarge();
  }

  private appendPartial(bytes: Uint8Array): void {
    if (bytes.length > statusV2Limits.maxRecordBytes - this.bufferedLength) this.tooLarge();
    const required = this.bufferedLength + bytes.length;
    this.ensureBufferedCapacity(required);
    this.buffered.set(bytes, this.bufferedLength);
    this.bufferedLength = required;
  }

  private ensureBufferedCapacity(required: number): void {
    if (required <= this.buffered.length) return;
    try {
      let capacity = Math.max(1024, this.buffered.length);
      while (capacity < required) capacity = Math.min(statusV2Limits.maxRecordBytes, capacity * 2);
      const grown = new Uint8Array(capacity);
      grown.set(this.buffered.subarray(0, this.bufferedLength));
      this.buffered = grown;
    } catch {
      this.tooLarge();
    }
  }

  private completeRecord(bytes: Uint8Array): void {
    if (bytes.length > statusV2Limits.maxRecordBytes - this.bufferedLength) this.tooLarge();
    if (this.recordCount >= statusV2Limits.maxRecords) this.tooLarge();
    this.recordCount += 1;

    if (this.bufferedLength === 0) {
      this.consume(this.decode(bytes));
      return;
    }

    this.appendPartial(bytes);
    const record = this.buffered.subarray(0, this.bufferedLength);
    this.bufferedLength = 0;
    this.consume(this.decode(record));
  }

  private decode(record: Uint8Array): string {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(record);
    } catch (error) {
      if (error instanceof RangeError) return this.tooLarge();
      return this.fail();
    }
  }

  private consume(record: string): void {
    try {
      if (this.pendingRename !== undefined) {
        this.addChange({ ...this.pendingRename, originalPath: parsePath(record) });
        this.pendingRename = undefined;
        return;
      }

      if (record.startsWith('#')) {
        this.consumeHeader(record);
        return;
      }
      if (record.startsWith('1 ')) {
        this.consumeOrdinary(record);
        return;
      }
      if (record.startsWith('2 ')) {
        this.consumeRename(record);
        return;
      }
      if (record.startsWith('u ')) {
        this.consumeUnmerged(record);
        return;
      }
      if (record.startsWith('? ')) {
        this.consumePathOnly(record, 'untracked');
        return;
      }
      if (record.startsWith('! ')) {
        this.consumePathOnly(record, 'ignored');
        return;
      }
      if (/^[12u?!]/.test(record)) this.fail();
      this.addDiagnostic({ code: 'UNKNOWN_RECORD' });
    } catch (error) {
      if (error instanceof GitWorkbenchError) throw error;
      this.fail();
    }
  }

  private addDiagnostic(diagnostic: StatusV2Diagnostic): void {
    if (this.mutableDiagnostics.length >= statusV2Limits.maxDiagnostics) this.tooLarge();
    this.mutableDiagnostics.push(diagnostic);
  }

  private addChange(change: WorkingTreeChange): void {
    if (this.changes.length >= statusV2Limits.maxChanges) this.tooLarge();
    this.changes.push(change);
  }

  private consumeHeader(record: string): void {
    if (!record.startsWith('# ')) this.fail();
    const value = record.slice(2);
    const separator = value.indexOf(' ');
    if (separator < 1) this.fail();
    const key = value.slice(0, separator);
    const payload = value.slice(separator + 1);
    if (payload.length === 0) this.fail();

    switch (key) {
      case 'branch.oid':
        if (payload !== '(initial)') this.branch.headOid = asObjectId(payload);
        return;
      case 'branch.head':
        if (payload !== '(detached)') this.branch.headName = payload;
        return;
      case 'branch.upstream':
        this.branch.upstream = payload;
        return;
      case 'branch.ab': {
        const match = /^\+(\d+) -(\d+)$/.exec(payload);
        if (match === null || !isSafeCount(match[1]!) || !isSafeCount(match[2]!)) this.fail();
        this.branch.ahead = Number(match[1]);
        this.branch.behind = Number(match[2]);
        return;
      }
      default:
        if (key.startsWith('branch.')) this.fail();
        this.addDiagnostic({ code: 'UNKNOWN_HEADER' });
    }
  }

  private consumeOrdinary(record: string): void {
    const parsed = fieldsAndPath(record, 8);
    if (parsed === undefined) this.fail();
    const [fields, path] = parsed;
    const [kind, xy, submodule, modeHead, modeIndex, modeWorktree, oidHead, oidIndex] = fields;
    if (kind !== '1' || xy === undefined || submodule === undefined
      || !/^[0-7]{6}$/.test(modeHead!) || !/^[0-7]{6}$/.test(modeIndex!) || !/^[0-7]{6}$/.test(modeWorktree!)) this.fail();
    const status = parseOrdinaryXY(xy);
    const nested = isSubmodule(submodule);
    if (status === undefined || nested === undefined) this.fail();
    asObjectId(oidHead!);
    asObjectId(oidIndex!);
    this.addChange({ path: parsePath(path), index: status[0], worktree: status[1], submodule: nested });
  }

  private consumeRename(record: string): void {
    const parsed = fieldsAndPath(record, 9);
    if (parsed === undefined) this.fail();
    const [fields, path] = parsed;
    const [kind, xy, submodule, modeHead, modeIndex, modeWorktree, oidHead, oidIndex, score] = fields;
    const status = parseRenameCopyXY(xy ?? '');
    const scoreMatch = /^([RC])(0|[1-9]\d?|100)$/.exec(score ?? '');
    if (kind !== '2' || xy === undefined || submodule === undefined || scoreMatch === null
      || scoreMatch[1] !== xy[0]
      || !/^[0-7]{6}$/.test(modeHead!) || !/^[0-7]{6}$/.test(modeIndex!) || !/^[0-7]{6}$/.test(modeWorktree!)) this.fail();
    const nested = isSubmodule(submodule);
    if (status === undefined || nested === undefined) this.fail();
    asObjectId(oidHead!);
    asObjectId(oidIndex!);
    this.pendingRename = { path: parsePath(path), index: status[0], worktree: status[1], submodule: nested };
  }

  private consumeUnmerged(record: string): void {
    const parsed = fieldsAndPath(record, 10);
    if (parsed === undefined) this.fail();
    const [fields, path] = parsed;
    const [kind, xy, submodule, ...metadata] = fields;
    if (kind !== 'u' || xy === undefined || submodule === undefined || metadata.length !== 7
      || !metadata.slice(0, 4).every((mode) => /^[0-7]{6}$/.test(mode))
      || !metadata.slice(4).every((oid) => {
        asObjectId(oid);
        return true;
      })) this.fail();
    const nested = isSubmodule(submodule);
    if (!unmergedXy.has(xy) || nested === undefined) this.fail();
    this.addChange({ path: parsePath(path), index: 'unmerged', worktree: 'unmerged', submodule: nested });
  }

  private consumePathOnly(record: string, kind: 'untracked' | 'ignored'): void {
    const path = record.slice(2);
    this.addChange({ path: parsePath(path), index: kind, worktree: kind, submodule: false });
  }
}

export const parseStatusV2 = (bytes: Uint8Array, generation: number): RepositoryStatus => {
  const decoder = new StatusV2Decoder(generation);
  decoder.push(bytes);
  return decoder.finish();
};
