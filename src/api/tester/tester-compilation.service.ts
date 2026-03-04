import { Inject, Injectable } from '@nestjs/common';
import { CompilationStatus, Prisma, tester } from '@prisma/client';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { constants as fsConstants, promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';

export interface CompileTesterJobData {
  testerId: string;
  sourceCodeHash: string;
}

interface MavenCompileResult {
  exitCode: number;
  stderr: string;
  timedOut: boolean;
}

/**
 * Manages tester compilation lifecycle by enqueueing async jobs and
 * executing Maven builds from the boilerplate harness in background workers.
 */
@Injectable()
export class TesterCompilationService {
  private readonly logger = LoggerService.forRoot('TesterCompilationService');
  private readonly compileTimeoutMs = this.getCompileTimeoutMs();
  private readonly mavenBinary = process.env.MVN_BINARY?.trim() || 'mvn';
  private readonly boilerplateDir =
    process.env.BOILERPLATE_DIR?.trim() ||
    path.resolve(process.cwd(), 'ecs-runner/boilerplate');
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';
  private readonly compileJavaMaxHeapMb = this.getCompileJavaMaxHeapMb();
  private readonly compileMavenOpts = this.getCompileMavenOpts();
  private inlineCompilationChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
  ) {}

  /**
   * Marks a tester for compilation and enqueues an async compile job.
   * When `DISABLE_PG_BOSS=true`, compilation runs inline on this API instance
   * using a serialized in-memory chain to avoid spawning overlapping Maven jobs.
   * @param testerId ID of the tester whose source should be compiled.
   * @param sourceCode Source code revision that should be compiled.
   * @returns Promise that resolves when DB status is updated and compilation is queued or started.
   * @throws Error If queueing fails; the tester is marked FAILED for the same source revision.
   */
  async enqueueCompilation(
    testerId: string,
    sourceCode: string,
  ): Promise<void> {
    const payload: CompileTesterJobData = {
      testerId,
      sourceCodeHash: this.hashSourceCode(sourceCode),
    };

    const pendingUpdate = await this.prisma.tester.updateMany({
      where: { id: testerId, sourceCode },
      data: {
        compilationStatus: CompilationStatus.PENDING,
        compilationError: null,
      },
    });

    if (pendingUpdate.count === 0) {
      this.logger.log(
        `Skipping enqueue for tester ${testerId}: source changed before queue submission.`,
      );
      return;
    }

    try {
      if (this.pgBossDisabled) {
        this.logger.warn(
          `DISABLE_PG_BOSS=true, running compilation inline for tester ${testerId}.`,
        );
        this.inlineCompilationChain = this.inlineCompilationChain
          .catch(() => undefined)
          .then(async () => {
            await this.runCompilation(payload);
          });
        return;
      }

      await this.pgBoss.send('compile-tester', payload);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const queueErrorMessage = `Failed to enqueue compilation job: ${errorMessage}`;

      this.logger.error(
        `Failed to enqueue compilation for tester ${testerId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.persistCompilationFailure(
        testerId,
        queueErrorMessage,
        sourceCode,
      );

      throw error;
    }
  }

  /**
   * Executes tester compilation for a queued job by injecting source code into
   * the Java boilerplate project and invoking Maven package.
   * @param jobData Queue payload with tester id and immutable source revision hash.
   * @returns Promise that resolves after status and artifact updates are persisted.
   * @throws Error Compilation exceptions are captured and persisted as FAILED state.
   */
  async runCompilation(jobData: CompileTesterJobData): Promise<void> {
    const { testerId, sourceCodeHash } = jobData;
    let tempDir: string | null = null;
    let sourceSnapshot: string | null = null;

    try {
      const testerRecord = await this.prisma.tester.findUnique({
        where: { id: testerId },
      });

      if (!testerRecord) {
        this.logger.warn(
          `Skipping compilation job for tester ${testerId}: tester not found.`,
        );
        return;
      }

      sourceSnapshot = testerRecord.sourceCode;

      if (this.hashSourceCode(testerRecord.sourceCode) !== sourceCodeHash) {
        this.logger.log(
          `Skipping stale compilation job for tester ${testerId}: source revision no longer matches queued payload.`,
        );
        return;
      }

      const tempRootDir = await this.resolveWritableTempRoot();
      tempDir = path.join(tempRootDir, `${testerId}-${Date.now()}`);
      await fs.mkdir(tempDir, { recursive: true });
      await fs.cp(this.boilerplateDir, tempDir, { recursive: true });

      await this.writeTesterSource(tempDir, testerRecord);

      const pomPath = path.join(tempDir, 'pom.xml');
      const compileResult = await this.executeMavenBuild(pomPath, tempDir);

      if (!compileResult.timedOut && compileResult.exitCode === 0) {
        const jarBytes = await this.readCompiledJar(tempDir);

        const successUpdate = await this.prisma.tester.updateMany({
          where: { id: testerId, sourceCode: sourceSnapshot },
          data: {
            compilationStatus: CompilationStatus.SUCCESS,
            jarFile: Uint8Array.from(jarBytes),
            compilationError: null,
          },
        });

        if (successUpdate.count === 0) {
          this.logger.log(
            `Skipping SUCCESS persistence for tester ${testerId}: source changed during compilation.`,
          );
        }

        return;
      }

      const timeoutMessage = `Compilation timed out after ${this.compileTimeoutMs}ms.`;
      const failureMessage = compileResult.timedOut
        ? [timeoutMessage, compileResult.stderr].filter(Boolean).join('\n')
        : compileResult.stderr ||
          `Compilation failed with exit code ${compileResult.exitCode}.`;

      const failedUpdate = await this.prisma.tester.updateMany({
        where: { id: testerId, sourceCode: sourceSnapshot },
        data: {
          compilationStatus: CompilationStatus.FAILED,
          compilationError: failureMessage,
        },
      });

      if (failedUpdate.count === 0) {
        this.logger.log(
          `Skipping FAILED persistence for tester ${testerId}: source changed during compilation.`,
        );
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error(
        `Compilation failed unexpectedly for tester ${testerId}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      await this.persistCompilationFailure(
        testerId,
        errorMessage,
        sourceSnapshot,
      );
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Parses compile timeout config from environment.
   * @returns Timeout in milliseconds with a default of 120000ms.
   */
  private getCompileTimeoutMs(): number {
    const parsed = Number.parseInt(process.env.COMPILE_TIMEOUT_MS ?? '', 10);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    return 120000;
  }

  /**
   * Parses JVM heap cap (MB) used for Maven compilation child processes.
   * @returns Heap cap in MB with a default of 384MB.
   */
  private getCompileJavaMaxHeapMb(): number {
    const parsed = Number.parseInt(
      process.env.COMPILE_JAVA_MAX_HEAP_MB ?? '',
      10,
    );

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    return 384;
  }

  /**
   * Builds `MAVEN_OPTS` for compilation workers with a default heap cap.
   * Priority: `COMPILE_MAVEN_OPTS` > `MAVEN_OPTS` > generated `-Xmx`.
   * If no `-Xmx` is present, an `-Xmx` cap is appended automatically.
   * @returns Effective MAVEN_OPTS string for `mvn` child process.
   */
  private getCompileMavenOpts(): string {
    const compileSpecificOptions = process.env.COMPILE_MAVEN_OPTS?.trim() ?? '';
    const inheritedOptions = process.env.MAVEN_OPTS?.trim() ?? '';
    const baseOptions = compileSpecificOptions || inheritedOptions;

    if (/-Xmx\S+/i.test(baseOptions)) {
      return baseOptions;
    }

    const heapCapOption = `-Xmx${this.compileJavaMaxHeapMb}m`;
    return baseOptions ? `${baseOptions} ${heapCapOption}` : heapCapOption;
  }

  /**
   * Calculates the immutable hash marker used to associate jobs with source revisions.
   * @param sourceCode Tester source string.
   * @returns SHA-256 hash hex digest for the provided source.
   */
  private hashSourceCode(sourceCode: string): string {
    return createHash('sha256').update(sourceCode).digest('hex');
  }

  /**
   * Finds a writable root directory for compilation temp workspaces.
   *
   * Candidate order:
   * 1) `COMPILATION_TMP_DIR`
   * 2) `TMPDIR`
   * 3) `/dev/shm` (Linux memory-backed tmpfs)
   * 4) `os.tmpdir()`
   * 5) `<process.cwd()>/tmp`
   *
   * @returns Absolute writable directory path.
   * @throws Error When none of the candidates can be created or written.
   */
  private async resolveWritableTempRoot(): Promise<string> {
    const configuredTmpDir = process.env.COMPILATION_TMP_DIR?.trim();
    const envTmpDir = process.env.TMPDIR?.trim();
    const linuxRamTmpfsDir = process.platform === 'linux' ? '/dev/shm' : null;
    const fallbackTmpDir = path.resolve(process.cwd(), 'tmp');

    const candidates = Array.from(
      new Set(
        [
          configuredTmpDir,
          envTmpDir,
          linuxRamTmpfsDir,
          os.tmpdir(),
          fallbackTmpDir,
        ].filter((value): value is string =>
          Boolean(value && value.length > 0),
        ),
      ),
    );

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        await this.ensureWritableDirectory(candidate);
        return candidate;
      } catch (error) {
        lastError = error;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Temp root candidate is not writable: ${candidate}. ${errorMessage}`,
        );
      }
    }

    const detail =
      lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(
      `No writable temporary directory is available for tester compilation. Last error: ${detail}`,
    );
  }

  /**
   * Verifies a candidate temp root exists and is writable by creating a probe file.
   * @param candidate Absolute candidate path.
   * @returns Promise that resolves when write access is confirmed.
   * @throws Error When directory creation or probe write fails.
   */
  private async ensureWritableDirectory(candidate: string): Promise<void> {
    await fs.mkdir(candidate, { recursive: true });
    await fs.access(candidate, fsConstants.W_OK);

    const probeFile = path.join(
      candidate,
      `.mm-compile-probe-${process.pid}-${Date.now()}`,
    );

    try {
      await fs.writeFile(probeFile, 'ok', 'utf8');
    } finally {
      await fs.rm(probeFile, { force: true }).catch(() => undefined);
    }
  }

  /**
   * Persists FAILED status for the relevant source revision when compilation setup fails.
   * @param testerId Tester identifier.
   * @param failureMessage Error text stored in `compilationError`.
   * @param sourceSnapshot Source snapshot for revision-safe conditional updates.
   * @returns Promise that resolves after best-effort failure persistence.
   */
  private async persistCompilationFailure(
    testerId: string,
    failureMessage: string,
    sourceSnapshot: string | null,
  ): Promise<void> {
    const where: Prisma.testerWhereInput = sourceSnapshot
      ? { id: testerId, sourceCode: sourceSnapshot }
      : { id: testerId };

    await this.prisma.tester
      .updateMany({
        where,
        data: {
          compilationStatus: CompilationStatus.FAILED,
          compilationError: failureMessage,
        },
      })
      .then((result) => {
        if (sourceSnapshot && result.count === 0) {
          this.logger.log(
            `Skipping FAILED persistence for tester ${testerId}: source changed before error could be written.`,
          );
        }
      })
      .catch((updateError) => {
        const message =
          updateError instanceof Error
            ? updateError.message
            : String(updateError);
        this.logger.error(
          `Failed to persist compilation error for tester ${testerId}: ${message}`,
        );
      });
  }

  /**
   * Writes tester source code into a package directory derived from className.
   * @param tempDir Temp compilation workspace root.
   * @param testerRecord Tester DB record containing className and sourceCode.
   * @returns Promise that resolves after writing `<ClassName>.java`.
   * @throws Error When className cannot be mapped to a Java class file.
   */
  private async writeTesterSource(
    tempDir: string,
    testerRecord: tester,
  ): Promise<void> {
    const classNameParts = testerRecord.className
      .split('.')
      .map((part) => part.trim())
      .filter((part) => part.length > 0);

    const className = classNameParts.at(-1);

    if (!className) {
      throw new Error(
        `Invalid className '${testerRecord.className}' for tester ${testerRecord.id}.`,
      );
    }

    const packagePath = path.join(
      tempDir,
      'src/main/java',
      ...classNameParts.slice(0, -1),
    );

    await fs.mkdir(packagePath, { recursive: true });

    const testerFilePath = path.join(packagePath, `${className}.java`);
    await fs.writeFile(testerFilePath, testerRecord.sourceCode, 'utf8');
  }

  /**
   * Runs Maven package for the prepared boilerplate project and captures stderr.
   * @param pomPath Absolute path to the temporary `pom.xml` file.
   * @param compileTempDir Writable temp directory used for Maven/JVM temp files.
   * @returns Compile result including exit code, stderr and timeout state.
   */
  private async executeMavenBuild(
    pomPath: string,
    compileTempDir: string,
  ): Promise<MavenCompileResult> {
    return await new Promise<MavenCompileResult>((resolve) => {
      const mavenOptsWithTmpDir = [
        this.compileMavenOpts,
        `-Djava.io.tmpdir=${compileTempDir}`,
        `-Djansi.tmpdir=${compileTempDir}`,
      ]
        .join(' ')
        .trim();
      const compileEnv = {
        ...process.env,
        TMPDIR: compileTempDir,
        TMP: compileTempDir,
        TEMP: compileTempDir,
        JANSI_TMPDIR: compileTempDir,
        MAVEN_OPTS: mavenOptsWithTmpDir,
      };

      const child = spawn(
        this.mavenBinary,
        ['clean', 'package', '-f', pomPath, '-q'],
        {
          env: compileEnv,
        },
      );

      let stderrBuffer = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.compileTimeoutMs);

      child.stderr.on('data', (chunk: Buffer) => {
        stderrBuffer += chunk.toString();
      });

      child.on('error', (error: Error) => {
        stderrBuffer += `${error.message}\n`;
      });

      child.on('close', (code: number | null) => {
        clearTimeout(timer);
        resolve({
          exitCode: code ?? -1,
          stderr: stderrBuffer.trim(),
          timedOut,
        });
      });
    });
  }

  /**
   * Reads the produced fat JAR from Maven target output.
   * @param tempDir Temp compilation workspace root.
   * @returns Jar bytes to persist in the tester record.
   * @throws Error When no jar artifact is found.
   */
  private async readCompiledJar(tempDir: string): Promise<Buffer> {
    const targetDir = path.join(tempDir, 'target');
    const targetFiles = await fs.readdir(targetDir);

    const preferredJar = targetFiles
      .filter(
        (fileName) =>
          fileName.endsWith('.jar') && !fileName.startsWith('original-'),
      )
      .sort()[0];

    const fallbackJar = targetFiles
      .filter((fileName) => fileName.endsWith('.jar'))
      .sort()[0];

    const jarFile = preferredJar || fallbackJar;

    if (!jarFile) {
      throw new Error('Compilation succeeded but no JAR artifact was found.');
    }

    return await fs.readFile(path.join(targetDir, jarFile));
  }
}
