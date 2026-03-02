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

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly testerCompilationService: TesterCompilationService,
  ) {}

  /**
   * Starts pg-boss and registers a worker for tester compilation jobs.
   * @returns Promise that resolves after worker registration is complete.
   * @throws Error If queue startup or worker registration fails.
   */
  async onModuleInit(): Promise<void> {
    await this.pgBoss.start();

    await this.pgBoss.work<CompileTesterJobData>(
      'compile-tester',
      { teamSize: 2, teamConcurrency: 1 } as unknown as PgBoss.WorkOptions,
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

    this.logger.log('Registered pg-boss worker for compile-tester jobs.');
  }

  /**
   * Stops pg-boss when the module is shutting down.
   * @returns Promise that resolves after worker shutdown completes.
   */
  async onModuleDestroy(): Promise<void> {
    await this.pgBoss.stop();
  }
}
