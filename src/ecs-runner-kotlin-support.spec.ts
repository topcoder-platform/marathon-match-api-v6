import { readFileSync } from 'fs';
import { join, resolve } from 'path';

describe('ECS runner Kotlin support', () => {
  const repoRoot = join(__dirname, '..');
  const runnerSource = readFileSync(
    join(
      repoRoot,
      'ecs-runner',
      'src',
      'main',
      'java',
      'com',
      'topcoder',
      'runner',
      'EcsRunnerMain.java',
    ),
    'utf8',
  );

  it('installs the Kotlin compiler in the runner image', () => {
    const dockerfile = readFileSync(
      resolve(repoRoot, 'ecs-runner/Dockerfile'),
      'utf8',
    );

    expect(dockerfile).toContain('kotlin');
    expect(dockerfile).toContain('kotlinc -version');
  });

  it('supports Kotlin submissions in the generic Java runner path', () => {
    expect(runnerSource).toContain('".kt"');
    expect(runnerSource).toContain('"kotlinc"');
    expect(runnerSource).toContain('"-include-runtime"');
    expect(runnerSource).toContain('"Kotlin compilation failed."');
    expect(runnerSource).toContain('return "kotlin";');
  });

  it('supports Kotlin submissions in the legacy checker scripts', () => {
    const solutionScript = readFileSync(
      resolve(repoRoot, 'ecs-runner/boilerplate/checker/solution.sh'),
      'utf8',
    );
    const kotlinScript = readFileSync(
      resolve(repoRoot, 'ecs-runner/boilerplate/checker/solution_kotlin.sh'),
      'utf8',
    );

    expect(solutionScript).toContain('${FILE}.kt');
    expect(solutionScript).toContain('./solution_kotlin.sh');
    expect(kotlinScript).toContain('kotlinc /workdir/${NAME}.kt');
    expect(kotlinScript).toContain('-include-runtime');
    expect(kotlinScript).toContain(
      'java -Xms1G -Xmx1G -jar /workdir/${NAME}.jar',
    );
  });
});
