import { readFileSync } from 'fs';
import { join } from 'path';

describe('ECS runner tester JAR isolation', () => {
  const runnerSource = readFileSync(
    join(
      process.cwd(),
      'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
    ),
    'utf8',
  );

  it('creates downloaded tester JARs as unique temp files', () => {
    expect(runnerSource).toContain(
      'Path jarPath = createRunnerOnlyTempFile("tester-", ".jar");',
    );
    expect(runnerSource).not.toContain(
      'Paths.get("/tmp/tester-" + testerConfigId + ".jar")',
    );
  });

  it('makes downloaded tester JARs read-only to the trusted runner owner', () => {
    expect(runnerSource).toContain('secureRunnerReadOnlyFile(jarPath);');
    expect(runnerSource).toContain('setRunnerOnlyPermissions(path, false);');
  });
});
