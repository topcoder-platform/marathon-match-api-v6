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

  it('keeps scorer process launch as a narrow setuid bridge', () => {
    const dockerfile = readRepoFile('ecs-runner/Dockerfile');
    const helperSource = readRepoFile('ecs-runner/scripts/mm-net-isolate.c');

    expect(dockerfile).toMatch(
      /-DMM_SUPERVISE_CHILD=1\s+\\\s+-DMM_DROP_SUPERVISOR_PRIVS=1\s+\\\s+-o \/usr\/local\/bin\/mm-scorer-isolate/,
    );
    expect(dockerfile).toContain('chmod 4755 /usr/local/bin/mm-scorer-isolate');
    expect(helperSource).toContain('#define MM_DROP_SUPERVISOR_PRIVS 0');
    expect(helperSource).toContain('drop_supervisor_to_invoker');
  });
});
