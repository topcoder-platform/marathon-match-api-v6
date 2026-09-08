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
  executeMavenBuild: (
    pomPath: string,
    compileTempDir: string,
  ) => Promise<{
    exitCode: number;
    output: string;
    timedOut: boolean;
  }>;
  readCompiledJar: (tempDir: string, className: string) => Promise<Buffer>;
  resolveWritableTempRoot: () => Promise<string>;
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

    return new TesterCompilationService(
      {} as never,
      {} as never,
    ) as unknown as TesterCompilationServicePrivate;
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

  it('reports every failed temp directory, including the configured volume permission error', async () => {
    jest.replaceProperty(process, 'env', {
      ...process.env,
      COMPILATION_TMP_DIR: '/work/mm-compile',
      TMPDIR: '/tmp',
    });
    const service = createService();
    const fallback = path.resolve(process.cwd(), 'tmp');
    jest.spyOn(fs, 'mkdir').mockImplementation((candidate) => {
      const code = candidate === '/work/mm-compile' ? 'EACCES' : 'EROFS';
      return Promise.reject(new Error(`${code}: mkdir '${String(candidate)}'`));
    });

    await expect(service.resolveWritableTempRoot()).rejects.toThrow(
      `No writable temporary directory is available for tester compilation. Attempted directories: /work/mm-compile: EACCES: mkdir '/work/mm-compile'; /tmp: EROFS: mkdir '/tmp'; ${fallback}: EROFS: mkdir '${fallback}'`,
    );
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('uses a writable configured volume when the root filesystem is read-only', async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mm-compile-root-'));
    tempDirs.push(tempDir);
    jest.replaceProperty(process, 'env', {
      ...process.env,
      COMPILATION_TMP_DIR: tempDir,
    });
    const service = createService();
    const realMkdir = fs.mkdir.bind(fs);
    jest.spyOn(fs, 'mkdir').mockImplementation((candidate, options) => {
      if (candidate !== tempDir) {
        return Promise.reject(new Error('EROFS: read-only file system'));
      }
      return realMkdir(candidate, options);
    });
    mockJarList({ exitCode: 0 });

    await expect(service.resolveWritableTempRoot()).resolves.toBe(tempDir);
    expect(await fs.readdir(tempDir)).toEqual([]);
    expect(mockedSpawn).toHaveBeenCalledWith(
      expect.stringMatching(/\.mm-compile-probe-.*\.sh$/),
      [],
      { env: process.env },
    );
  });

  it('captures Maven stdout and stderr in compilation output', async () => {
    const service = createService();
    const childProcess = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
      kill: jest.Mock;
    };
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = jest.fn();
    mockedSpawn.mockReturnValue(childProcess as never);

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
    expect(mockedSpawn).toHaveBeenCalledWith(
      'mvn',
      [
        'clean',
        'package',
        '-f',
        '/tmp/project/pom.xml',
        '-q',
        '-DskipTests',
      ],
      {
        env: expect.objectContaining({
          JANSI_MODE: 'off',
          JANSI_TMPDIR: '/tmp/project',
          TEMP: '/tmp/project',
          TMP: '/tmp/project',
          TMPDIR: '/tmp/project',
          MAVEN_OPTS: expect.stringContaining('-Djava.io.tmpdir=/tmp/project'),
        }),
      },
    );
  });

  it('reads the compiled jar when it contains the configured class', async () => {
    const service = createService();
    const { jarBytes, jarPath, tempDir } = await createJarArtifact();

    mockJarList({
      stdout:
        'META-INF/MANIFEST.MF\ncom/topcoder/mm/Tester.class\ncom/topcoder/mm/Tester$Helper.class\n',
    });

    await expect(
      service.readCompiledJar(tempDir, 'com.topcoder.mm.Tester'),
    ).resolves.toEqual(jarBytes);
    expect(mockedSpawn).toHaveBeenCalledWith('jar', ['tf', jarPath], {
      env: process.env,
    });
  });

  it('rejects a compiled jar that does not contain the configured class', async () => {
    const service = createService();
    const { tempDir } = await createJarArtifact();

    mockJarList({
      stdout: 'META-INF/MANIFEST.MF\ncom/foo/BlockGameTester.class\n',
    });

    await expect(
      service.readCompiledJar(tempDir, 'BlockGameTester'),
    ).rejects.toThrow(
      "Compilation succeeded but compiled JAR does not contain configured class 'BlockGameTester' (expected entry: BlockGameTester.class).",
    );
  });
});
