import { join } from 'node:path';

import { DurableJournal, type JournalRecord } from '@git-workbench/transactions';

export interface RecoveryEntry {
  readonly operationId: string;
  readonly repositoryId: string;
  readonly state: string;
  readonly lastRecord: JournalRecord;
}

/**
 * Read-only recovery center backend: lists operations whose journal ended in
 * a state requiring user attention (NeedsAttention, Paused or a dangling
 * non-terminal record after a crash).
 */
export class RecoveryService {
  constructor(private readonly journal: DurableJournal, private readonly journalRoot: string) {}

  async listAttention(): Promise<readonly RecoveryEntry[]> {
    const { readdir } = await import('node:fs/promises');
    const { createHash } = await import('node:crypto');
    const entries: RecoveryEntry[] = [];
    const repositoryDirs = await readdir(join(this.journalRoot)).catch(() => [] as string[]);
    for (const repositorySegment of repositoryDirs) {
      const operationDirs = await readdir(join(this.journalRoot, repositorySegment)).catch(() => [] as string[]);
      for (const operationSegment of operationDirs) {
        // Journal paths are digests of repositoryId/operationId; re-read via
        // the journal API by reversing them is not possible, so enumerate.
        const files = await readdir(join(this.journalRoot, repositorySegment, operationSegment)).catch(() => [] as string[]);
        const records: JournalRecord[] = [];
        for (const name of files.filter((file) => file.endsWith('.json')).sort()) {
          const { readFile } = await import('node:fs/promises');
          const payload = JSON.parse(await readFile(join(this.journalRoot, repositorySegment, operationSegment, name), 'utf8')) as { checksum: string; body: string };
          if (createHash('sha256').update(payload.body).digest('hex') !== payload.checksum) continue;
          records.push(JSON.parse(payload.body) as JournalRecord);
        }
        if (records.length === 0) continue;
        const last = records[records.length - 1]!;
        if (last.state === 'NeedsAttention' || last.state === 'Paused' || !['Committed', 'RolledBack', 'Rejected', 'Cancelled'].includes(last.state)) {
          entries.push({ operationId: last.operationId, repositoryId: last.repositoryId, state: last.state, lastRecord: last });
        }
      }
    }
    return entries;
  }
}
