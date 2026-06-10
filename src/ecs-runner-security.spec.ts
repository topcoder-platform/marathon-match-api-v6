import { readFileSync } from 'fs';
import { join } from 'path';

const repoRoot = join(__dirname, '..');

function readRepoFile(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

describe('ECS runner isolation image wiring', () => {
  it('runs the tester JVM as runner instead of skipping the uid drop', () => {
    const dockerfile = readRepoFile('ecs-runner/Dockerfile');

    expect(dockerfile).not.toContain('-DMM_SKIP_USER_DROP=1');
    expect(dockerfile).toMatch(
      /-DMM_INSTALL_SOCKET_FILTER=0\s+\\\s+-o \/usr\/local\/bin\/mm-runner-isolate/,
    );
  });

  it('keeps scorer process launch as a narrow setuid bridge with timeout kill forwarding', () => {
    const dockerfile = readRepoFile('ecs-runner/Dockerfile');
    const helperSource = readRepoFile('ecs-runner/scripts/mm-net-isolate.c');

    expect(dockerfile).toMatch(
      /-DMM_SUPERVISE_CHILD=1\s+\\\s+-DMM_DROP_SUPERVISOR_PRIVS=1\s+\\\s+-DMM_ENABLE_FS_SANDBOX=1\s+\\\s+-o \/usr\/local\/bin\/mm-scorer-isolate/,
    );
    expect(dockerfile).toContain('chmod 4755 /usr/local/bin/mm-scorer-isolate');
    expect(helperSource).toContain('#define MM_DROP_SUPERVISOR_PRIVS 0');
    expect(helperSource).toContain('#define MM_ENABLE_FS_SANDBOX 0');
    expect(helperSource).toContain('drop_supervisor_to_invoker');
    expect(helperSource).toContain('PR_SET_KEEPCAPS');
    expect(helperSource).toContain('supervisor capset(CAP_KILL)');
    expect(helperSource).toContain(
      'signal_child_process_group(child_pid, SIGKILL)',
    );
  });
});

describe('ECS runner tester JAR isolation', () => {
  const runnerSource = readRepoFile(
    'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
  );

  it('creates downloaded tester JARs as unique temp files', () => {
    expect(runnerSource).toContain(
      'Path jarPath = createRunnerOnlyTempFile("tester-", ".jar");',
    );
    expect(runnerSource).not.toContain(
      'Paths.get("/tmp/tester-" + testerConfigId + ".jar")',
    );
  });

  it('makes downloaded tester JARs runner-owned and read-only', () => {
    expect(runnerSource).toContain('secureRunnerOnlyFile(jarPath);');
    expect(runnerSource).toContain('setRunnerOnlyPermissions(path);');
    expect(runnerSource).not.toContain('secureRunnerReadOnlyFile');
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
