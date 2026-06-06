import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { LoggerService } from 'src/shared/modules/global/logger.service';

import { TesterCompilationService } from './tester-compilation.service';

jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'generated-id'),
}));

type TesterCompilationServicePrivate = TesterCompilationService & {
  readCompiledJar: (tempDir: string, className: string) => Promise<Buffer>;
};

describe('TesterCompilationService', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const mockedSpawn = jest.mocked(spawn);
  const tempDirs: string[] = [];

  const createService = () => {
    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    return new TesterCompilationService({} as never, {} as never);
  };

  const createJarArtifact = async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tester-compilation-'),
    );
    tempDirs.push(tempDir);

    const targetDir = path.join(tempDir, 'target');
    await fs.mkdir(targetDir);

    const jarPath = path.join(targetDir, 'mm-tester-harness-1.0.0.jar');
    const jarBytes = Buffer.from('compiled-jar');
    await fs.writeFile(jarPath, jarBytes);

    return {
      jarBytes,
      jarPath,
      tempDir,
    };
  };

  const mockJarList = ({
    exitCode = 0,
    stderr = '',
    stdout = '',
  }: {
    exitCode?: number;
    stderr?: string;
    stdout?: string;
  }) => {
    mockedSpawn.mockImplementation(() => {
      const child = new EventEmitter() as EventEmitter & {
        stderr: EventEmitter;
        stdout: EventEmitter;
      };
      child.stderr = new EventEmitter();
      child.stdout = new EventEmitter();

      process.nextTick(() => {
        if (stdout) {
          child.stdout.emit('data', Buffer.from(stdout));
        }
        if (stderr) {
          child.stderr.emit('data', Buffer.from(stderr));
        }
        child.emit('close', exitCode);
      });

      return child as never;
    });
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })),
    );
  });

  it('reads the compiled jar when it contains the configured class', async () => {
    const service = createService();
    const privateService =
      service as unknown as TesterCompilationServicePrivate;
    const { jarBytes, jarPath, tempDir } = await createJarArtifact();

    mockJarList({
      stdout:
        'META-INF/MANIFEST.MF\ncom/topcoder/mm/Tester.class\ncom/topcoder/mm/Tester$Helper.class\n',
    });

    await expect(
      privateService.readCompiledJar(tempDir, 'com.topcoder.mm.Tester'),
    ).resolves.toEqual(jarBytes);
    expect(mockedSpawn).toHaveBeenCalledWith('jar', ['tf', jarPath], {
      env: process.env,
    });
  });

  it('rejects a compiled jar that does not contain the configured class', async () => {
    const service = createService();
    const privateService =
      service as unknown as TesterCompilationServicePrivate;
    const { tempDir } = await createJarArtifact();

    mockJarList({
      stdout: 'META-INF/MANIFEST.MF\ncom/foo/BlockGameTester.class\n',
    });

    await expect(
      privateService.readCompiledJar(tempDir, 'BlockGameTester'),
    ).rejects.toThrow(
      "Compilation succeeded but compiled JAR does not contain configured class 'BlockGameTester' (expected entry: BlockGameTester.class).",
    );
  });
});
