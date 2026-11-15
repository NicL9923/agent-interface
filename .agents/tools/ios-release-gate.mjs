// What `publish-ios.mjs archive` must prove about the repository before it signs anything.
// Both checks read local files and run no Apple or signing code, so they run first and cannot be skipped.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const validateCommand = 'bash .agents/tools/validate-ios.sh SIMULATOR_UUID test';

const fail = (condition, reason) => { if (!condition) throw new Error(reason); };

// The generator owns the shipped version and build number. The checked-in project is generated from it.
export function repositoryRelease(repo, read = readFileSync) {
  const generator = read(join(repo, 'ios/tools/generate-project.py'), 'utf8');
  const field = name => generator.match(new RegExp(`^${name} = "([^"]+)"$`, 'm'))?.[1];
  const version = field('MARKETING_VERSION'), build = field('CURRENT_PROJECT_VERSION');
  fail(version && build && /^[1-9][0-9]{0,8}$/.test(build), 'ios/tools/generate-project.py has no readable MARKETING_VERSION and CURRENT_PROJECT_VERSION');
  return { version, build: Number(build) };
}

// The typed VERSION and BUILD confirm which release the operator means; the repository decides what ships.
export function requireRepositoryRelease(repo, version, build, read) {
  const expected = repositoryRelease(repo, read);
  fail(build === expected.build, `BUILD ${build} does not match CURRENT_PROJECT_VERSION ${expected.build} in ios/tools/generate-project.py. Change the number there, regenerate the project, commit, and run a full iOS validation before archiving. Never archive a build number the repository does not hold.`);
  fail(version === expected.version, `VERSION ${version} does not match MARKETING_VERSION ${expected.version} in ios/tools/generate-project.py. Change it there, regenerate the project, commit, and run a full iOS validation before archiving.`);
  return expected;
}

export const defaultExec = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error };
};

// A passing run of the whole scheme for the current iOS inputs, from ios-validation-state.py.
export function requireFullIosValidation(repo, exec = defaultExec) {
  const result = exec('python3', [join(repo, '.agents/tools/ios-validation-state.py'), 'full-run'], repo);
  const detail = result.error ? result.error.message : result.stderr.trim();
  const next = `Run it on this Mac, then archive again: ${validateCommand}`;
  // Exit 1 is the tool's own refusal and its stderr says why; anything else means the evidence could not be read.
  fail(!result.error && (result.status === 0 || result.status === 1), `Could not read the iOS validation evidence (${detail || `exit ${result.status}`}). ${next}`);
  fail(result.status === 0, `${detail} ${next}`);
  let evidence;
  try { evidence = JSON.parse(result.stdout); } catch { evidence = undefined; }
  fail(evidence && typeof evidence.source === 'string' && Number.isInteger(evidence.tests?.failed), `The iOS validation evidence was unreadable. ${next}`);
  fail(evidence.tests.failed === 0, `The iOS validation evidence records ${evidence.tests.failed} failing tests. ${next}`);
  return evidence;
}
