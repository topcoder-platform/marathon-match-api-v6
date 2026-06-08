import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('ECS runner C++ compile target', () => {
  const repoRoot = process.cwd();
  const expectedFlags = ['-march=x86-64', '-mtune=generic'];

  it.each([
    'ecs-runner/boilerplate/checker/solution_cpp.sh',
    'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
  ])('uses a fixed C++ target in %s', (relativePath) => {
    const contents = readFileSync(resolve(repoRoot, relativePath), 'utf8');

    for (const flag of expectedFlags) {
      expect(contents).toContain(flag);
    }
    expect(contents).not.toContain('-march=native');
  });
});
