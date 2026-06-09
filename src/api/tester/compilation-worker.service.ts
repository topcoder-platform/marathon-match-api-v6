import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';
import { PgBossLifecycleService } from 'src/shared/modules/pg-boss/pg-boss-lifecycle.service';
import {
  CompileTesterJobData,
  TesterCompilationService,
} from './tester-compilation.service';

/**
 * Registers and manages the background compilation worker that consumes
 * `compile-tester` jobs and delegates compile execution to TesterCompilationService.
 */
@Injectable()
export class CompilationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = LoggerService.forRoot('CompilationWorkerService');
  private readonly compileQueueName = 'compile-tester';
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';
  private readonly compileWorkerTeamSize = this.getPositiveIntEnv(
    'PG_BOSS_COMPILE_TEAM_SIZE',
    1,
  );
  private readonly compileWorkerTeamConcurrency = this.getPositiveIntEnv(
    'PG_BOSS_COMPILE_TEAM_CONCURRENCY',
    1,
  );
  private workerId?: string;
  private readonly handlePgBossError = (error: unknown): void => {
    const trace =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logger.error('pg-boss emitted an error event', trace);
  };

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly pgBossLifecycleService: PgBossLifecycleService,
    private readonly testerCompilationService: TesterCompilationService,
  ) {}

  /**
   * Starts pg-boss, ensures the compile queue exists, and registers a worker
   * for tester compilation jobs.
   * @returns Promise that resolves after worker registration is complete.
   * @throws Error If queue startup, queue creation, or worker registration fails.
   */
  async onModuleInit(): Promise<void> {
    if (this.pgBossDisabled) {
      this.logger.warn(
        'DISABLE_PG_BOSS=true, skipping pg-boss worker startup. Tester compilation will run inline.',
      );
      return;
    }

    this.pgBoss.on('error', this.handlePgBossError);
    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(this.compileQueueName);

    this.workerId = await this.pgBoss.work<CompileTesterJobData>(
      this.compileQueueName,
      {
        teamSize: this.compileWorkerTeamSize,
        teamConcurrency: this.compileWorkerTeamConcurrency,
      } as unknown as PgBoss.WorkOptions,
      async (
        jobOrJobs:
          | PgBoss.Job<CompileTesterJobData>[]
          | PgBoss.Job<CompileTesterJobData>,
      ) => {
        const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];

        for (const job of jobs) {
          await this.testerCompilationService.runCompilation(job.data);
        }
      },
    );

    this.logger.log(
      `Registered pg-boss worker for compile-tester jobs and ensured queue exists (teamSize=${this.compileWorkerTeamSize}, teamConcurrency=${this.compileWorkerTeamConcurrency}).`,
    );
  }

  /**
   * Stops pg-boss when the module is shutting down.
   * @returns Promise that resolves after worker shutdown completes.
   */
  async onModuleDestroy(): Promise<void> {
    if (this.pgBossDisabled) {
      return;
    }

    this.pgBoss.off('error', this.handlePgBossError);
    if (!this.workerId) {
      return;
    }

    try {
      await this.pgBoss.offWork({ id: this.workerId });
    } catch (error) {
      this.logger.warn({
        message: 'Unable to unregister compile-tester pg-boss worker cleanly.',
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Parses a positive integer environment variable with fallback.
   * @param envName Environment variable name.
   * @param defaultValue Value used when env is missing/invalid.
   * @returns Parsed positive integer or fallback.
   */
  private getPositiveIntEnv(envName: string, defaultValue: number): number {
    const rawValue = process.env[envName];
    const parsed = Number.parseInt(rawValue ?? '', 10);

    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }

    return defaultValue;
  }
}
