// Restart sampler: reads the complete paused state from Git facts alone.
// Invoked as a fresh process to prove the state survives a plugin restart.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const cwd = process.argv[2];

const probe = async (name) => execFileAsync('git', ['rev-parse', '--verify', '-q', name], { cwd }).then((result) => result.stdout.trim(), () => '');
const [mergeHead, rebaseHead, cherryHead, revertHead, unmerged, head] = await Promise.all([
  probe('MERGE_HEAD'),
  probe('REBASE_HEAD'),
  probe('CHERRY_PICK_HEAD'),
  probe('REVERT_HEAD'),
  execFileAsync('git', ['ls-files', '--unmerged', '-z'], { cwd }).then((result) => result.stdout, () => ''),
  execFileAsync('git', ['rev-parse', 'HEAD'], { cwd }).then((result) => result.stdout.trim()),
]);

const kind = rebaseHead ? 'rebase' : cherryHead ? 'cherryPick' : revertHead ? 'revert' : mergeHead ? 'merge' : 'none';
const paths = [...new Set(unmerged.split('\0').filter(Boolean).map((line) => line.split('\t')[1]))];
console.log(JSON.stringify({ kind, conflictedPaths: paths, conflictKinds: paths.map(() => 'text'), headOid: head }));
