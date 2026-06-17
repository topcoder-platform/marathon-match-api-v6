import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('ECS runner Rust backtrace configuration', () => {
  const repoRoot = process.cwd();

  it.each([
    'ecs-runner/boilerplate/checker/solution_rust.sh',
    'ecs-runner/src/main/java/com/topcoder/runner/EcsRunnerMain.java',
  ])('enables Rust panic backtraces in %s', (relativePath) => {
    const contents = readFileSync(resolve(repoRoot, relativePath), 'utf8');

    expect(contents).toContain('RUST_BACKTRACE=1');
  });
});
