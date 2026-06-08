import { readFileSync } from 'fs';
import { join } from 'path';

describe('ECS runner Java startup timeout guard', () => {
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

  it('loads compiled Java submissions under scorer isolation with the compile timeout', () => {
    expect(runnerSource).toContain('private static void runJavaStartupCheck(');
    expect(runnerSource).toContain(
      'Class.forName(args[0], true, Thread.currentThread().getContextClassLoader())',
    );
    expect(runnerSource).toContain('SCORER_ISOLATION_WRAPPER_PATH');

    expect(runnerSource).toMatch(
      /runCommand\(\s*Arrays\.asList\(\s*"javac",\s*"--release",\s*JAVA_SUBMISSION_RELEASE,\s*workDir\.relativize\(normalizedSource\)\.toString\(\)\s*\)[\s\S]*?"Java compilation failed\.",\s*compileLogPath\s*\);\s*runJavaStartupCheck\(workDir, entryPoint, compileTimeoutMs, compileLogPath\);/,
    );
  });
});
