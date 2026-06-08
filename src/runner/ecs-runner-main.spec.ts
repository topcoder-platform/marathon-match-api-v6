import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('EcsRunnerMain C# .NET extension handling', () => {
  const sourcePath = join(
    __dirname,
    '..',
    '..',
    'ecs-runner',
    'src',
    'main',
    'java',
    'com',
    'topcoder',
    'runner',
    'EcsRunnerMain.java',
  );
  const source = readFileSync(sourcePath, 'utf8');

  it('targets net7.0 and reports csharp-net7 for .cs_net7 submissions', () => {
    expect(source).toContain(
      '"    <TargetFramework>" + targetFramework + "</TargetFramework>"',
    );
    expect(source).toMatch(
      /if \("\.cs_net7"\.equals\(extension\)\) \{\s*return "net7\.0";\s*\}/,
    );
    expect(source).toMatch(
      /if \("\.cs_net7"\.equals\(extension\)\) \{\s*return "csharp-net7";\s*\}/,
    );
  });
});
