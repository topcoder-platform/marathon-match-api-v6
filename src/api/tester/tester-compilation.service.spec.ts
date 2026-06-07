import { spawn } from 'child_process';
import { EventEmitter } from 'events';

import { TesterCompilationService } from './tester-compilation.service';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'request-id'),
}));

interface ExposedTesterCompilationService {
  executeMavenBuild(
    pomPath: string,
    compileTempDir: string,
  ): Promise<{
    exitCode: number;
    output: string;
    timedOut: boolean;
  }>;
}

describe('TesterCompilationService', () => {
  const spawnMock = spawn as jest.MockedFunction<typeof spawn>;

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('captures Maven stdout and stderr in compilation output', async () => {
    const service = new TesterCompilationService(
      {} as never,
      {} as never,
    ) as unknown as ExposedTesterCompilationService;
    const childProcess = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: jest.Mock;
    };
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = jest.fn();
    spawnMock.mockReturnValue(childProcess as never);

    const resultPromise = service.executeMavenBuild(
      '/tmp/project/pom.xml',
      '/tmp/project',
    );

    childProcess.stdout.emit(
      'data',
      Buffer.from('[ERROR] Tester.java:12: cannot find symbol\n'),
    );
    childProcess.stderr.emit(
      'data',
      Buffer.from('javac failed with diagnostics\n'),
    );
    childProcess.emit('close', 1);

    await expect(resultPromise).resolves.toEqual({
      exitCode: 1,
      output:
        '[ERROR] Tester.java:12: cannot find symbol\njavac failed with diagnostics',
      timedOut: false,
    });
  });
});
