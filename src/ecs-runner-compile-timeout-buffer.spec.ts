import { readFileSync } from 'fs';
import { join } from 'path';

describe('ECS runner compile timeout buffer', () => {
  const runnerSource = readFileSync(
    join(
      __dirname,
      '..',
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

  it('buffers the announced compile timeout by ten seconds', () => {
    expect(runnerSource).toContain(
      'private static final int COMPILE_TIMEOUT_BUFFER_MS = 10000;',
    );
    expect(runnerSource).toContain(
      'private static int bufferedCompileTimeoutMs(int announcedTimeoutMs) {',
    );
    expect(runnerSource).toContain(
      'return announcedTimeoutMs + COMPILE_TIMEOUT_BUFFER_MS;',
    );
  });

  it('enforces compilation against the buffered timeout', () => {
    expect(runnerSource).toMatch(
      /boolean finished = process\.waitFor\(\s*bufferedCompileTimeoutMs\(timeoutMs\),\s*TimeUnit\.MILLISECONDS\s*\);/,
    );
  });

  it('keeps reporting the announced compile timeout to members', () => {
    expect(runnerSource).toContain(
      '"\\nTimed out after " + timeoutMs + "ms.\\n"',
    );
    expect(runnerSource).toMatch(
      /failureContext\s*\+ " Timed out after "\s*\+ timeoutMs/,
    );
    expect(runnerSource).toContain(
      'metadata.put("compileTimeoutMs", compileTimeoutMs);',
    );
  });

  it('leaves the announced default compile timeout unchanged', () => {
    expect(runnerSource).toContain(
      'private static final int DEFAULT_COMPILE_TIMEOUT_MS = 30000;',
    );
  });
});
