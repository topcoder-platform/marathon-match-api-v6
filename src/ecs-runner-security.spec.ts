import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('ECS runner isolation image wiring', () => {
  it('runs the trusted parent as non-root and bridges to a distinct tester uid', () => {
    const dockerfile = readRepoFile('ecs-runner/Dockerfile');
    const entrypoint = readRepoFile('ecs-runner/scripts/entrypoint.sh');

    expect(dockerfile).not.toContain('-DMM_SKIP_USER_DROP=1');
    expect(dockerfile).toMatch(
      /-DMM_INSTALL_SOCKET_FILTER=0\s+\\\s+-DMM_SUPERVISE_CHILD=1\s+\\\s+-DMM_DROP_SUPERVISOR_PRIVS=1\s+\\\s+-DMM_ISOLATED_UMASK=0007\s+\\\s+-o \/usr\/local\/bin\/mm-runner-isolate/,
    );
    expect(dockerfile).toContain(
      'useradd --create-home --uid 10000 --gid runner --shell /usr/sbin/nologin runner-parent',
    );
    expect(dockerfile).toContain(
      'useradd --create-home --uid 10001 --gid runner --shell /usr/sbin/nologin runner',
    );
    expect(dockerfile).toContain(
      'chown root:runner /usr/local/bin/mm-runner-isolate /usr/local/bin/mm-scorer-isolate',
    );
    expect(dockerfile).toContain('chmod 4750 /usr/local/bin/mm-runner-isolate');
    expect(dockerfile).toContain('USER runner-parent:runner');
    expect(entrypoint).toContain('trusted_parent_uid=10000');
    expect(entrypoint).not.toContain('id -u)" -ne 0');
  });

  it('keeps scorer process launch as a narrow setuid bridge with timeout kill forwarding', () => {
    const dockerfile = readRepoFile('ecs-runner/Dockerfile');
    const helperSource = readRepoFile('ecs-runner/scripts/mm-net-isolate.c');

    expect(dockerfile).toMatch(
      /-DMM_ENABLE_ADMIN_MODES=1\s+\\\s+-DMM_SUPERVISE_CHILD=1\s+\\\s+-DMM_DROP_SUPERVISOR_PRIVS=1\s+\\\s+-DMM_ENABLE_FS_SANDBOX=1\s+\\\s+-o \/usr\/local\/bin\/mm-scorer-isolate/,
    );
    expect(dockerfile).toContain('chmod 4750 /usr/local/bin/mm-scorer-isolate');
    expect(helperSource).toContain('#define MM_DROP_SUPERVISOR_PRIVS 0');
    expect(helperSource).toContain('#define MM_ENABLE_FS_SANDBOX 0');
    expect(helperSource).toContain('drop_supervisor_to_invoker');
    expect(helperSource).toContain('PR_SET_KEEPCAPS');
    expect(helperSource).toContain('supervisor capset(CAP_KILL)');
    expect(helperSource).toContain(
      'signal_child_process_group(child_pid, SIGKILL)',
    );
  });

  it('resets scorer-owned writable state through the setuid scorer helper', () => {
    const runnerSource = readRepoFile(
      'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
    );
    const helperSource = readRepoFile('ecs-runner/scripts/mm-net-isolate.c');

    expect(runnerSource).toContain(
      'private static final String SCORER_STATE_CLEANUP_ARGUMENT',
    );
    expect(runnerSource).toContain(
      'SCORER_ISOLATION_WRAPPER_PATH,\n            SCORER_STATE_CLEANUP_ARGUMENT',
    );
    expect(runnerSource).toContain(
      'SCORER_ISOLATION_WRAPPER_PATH,\n                SCORER_PROCESS_CLEANUP_ARGUMENT',
    );
    expect(helperSource).toContain(
      'argc == 2 && strcmp(argv[1], "--cleanup-scorer-state") == 0',
    );
    expect(helperSource).toContain('cleanup_scorer_writable_state');
    expect(helperSource).toContain('terminate_isolated_user_processes');
    expect(helperSource).toContain('"--kill-isolated-processes"');
    expect(helperSource).toContain(
      'opened_stat.st_uid != (uid_t) MM_ISOLATED_UID',
    );
    expect(helperSource).toContain(
      'entry_stat.st_uid != (uid_t) MM_ISOLATED_UID',
    );
    expect(helperSource).toContain('remove_tree_at');
    expect(helperSource).toContain('O_DIRECTORY | O_CLOEXEC | O_NOFOLLOW');
    expect(helperSource).toContain('AT_SYMLINK_NOFOLLOW');
    expect(helperSource).toContain('unlinkat(parent_fd, name, AT_REMOVEDIR)');
  });
});

describe('ECS runner tester JAR isolation', () => {
  const runnerSource = readRepoFile(
    'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
  );

  it('creates downloaded tester JARs as unique temp files', () => {
    expect(runnerSource).toContain(
      'Path jarPath = createRunnerHandoffTempFile(null, "tester-", ".jar");',
    );
    expect(runnerSource).not.toContain(
      'Paths.get("/tmp/tester-" + testerConfigId + ".jar")',
    );
  });

  it('makes downloaded tester JARs parent-owned and runner-group-readable', () => {
    expect(runnerSource).toContain('secureRunnerHandoffFile(jarPath);');
    expect(runnerSource).toContain('setRunnerHandoffPermissions(path);');
    expect(runnerSource).toContain('PosixFilePermission.GROUP_READ');
    expect(runnerSource).not.toContain('secureRunnerOnlyFile');
  });
});

describe('ECS runner submitted-solution timeout handling', () => {
  it('lets the scorer wrapper forward timeout termination and unblocks tester reads', () => {
    const harnessSource = readRepoFile(
      'ecs-runner/boilerplate/src/main/java/com/topcoder/marathon/MarathonTester.java',
    );

    expect(harnessSource).toContain('private void terminateTimedOutProcess()');
    expect(harnessSource).toMatch(
      /processToStop\.destroy\(\);[\s\S]*processToStop\.destroyForcibly\(\);/,
    );
    expect(harnessSource).toContain('closeSolutionStreamsAfterTimeout();');
    expect(harnessSource).toContain('solOutputReader.close();');
  });
});
