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
import { ScoringResultService } from './scoring-result.service';
import {
  RELATIVE_SCORING_RECOMPUTE_QUEUE,
  RelativeScoringRecomputeJobData,
} from './relative-scoring-recompute-scheduler.service';

/**
 * Consumes deferred relative scoring recomputation jobs. The service worker
 * keeps queue concurrency configurable while `ScoringResultService` still uses
 * a database advisory lock to serialize writes for one challenge and phase.
 */
@Injectable()
export class RelativeScoringRecomputeWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = LoggerService.forRoot(
    'RelativeScoringRecomputeWorkerService',
  );
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';
  private workerId?: string;
  private readonly handlePgBossError = (error: unknown): void => {
    const trace =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.logger.error('pg-boss emitted an error event', trace);
  };

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly pgBossLifecycleService: PgBossLifecycleService,
    private readonly scoringResultService: ScoringResultService,
  ) {}

  /**
   * Starts the relative scoring recompute worker.
   * @returns Promise that resolves after worker registration is complete.
   * @throws Error when pg-boss startup or worker registration fails.
   */
  async onModuleInit(): Promise<void> {
    if (this.pgBossDisabled) {
      this.logger.warn(
        'DISABLE_PG_BOSS=true, skipping relative-scoring-recompute worker startup.',
      );
      return;
    }

    this.pgBoss.on('error', this.handlePgBossError);
    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(RELATIVE_SCORING_RECOMPUTE_QUEUE, {
      retryLimit: this.getRetryLimit(),
      retryDelay: this.getRetryDelaySeconds(),
      retryBackoff: false,
    });

    this.workerId = await this.pgBoss.work<RelativeScoringRecomputeJobData>(
      RELATIVE_SCORING_RECOMPUTE_QUEUE,
      {
        teamSize: this.getWorkerConcurrency(),
        teamConcurrency: this.getWorkerConcurrency(),
      } as unknown as PgBoss.WorkOptions,
      async (
        jobOrJobs:
          | PgBoss.Job<RelativeScoringRecomputeJobData>[]
          | PgBoss.Job<RelativeScoringRecomputeJobData>,
      ) => {
        const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];

        for (const job of jobs) {
          await this.handleRecomputeJob(job.data);
        }
      },
    );

    this.logger.log(
      `Registered pg-boss worker for ${RELATIVE_SCORING_RECOMPUTE_QUEUE} jobs.`,
    );
  }

  /**
   * Unregisters the recompute worker during shutdown.
   * @returns Promise that resolves after worker unregister completes.
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
        message:
          'Unable to unregister relative-scoring-recompute pg-boss worker cleanly.',
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handles one deferred relative scoring recomputation request.
   * @param data Job payload with challenge, phase, submission, and review context.
   * @returns Promise that resolves after recomputation has completed or been skipped.
   * @throws Error when recomputation fails; pg-boss will retry the job.
   */
  private async handleRecomputeJob(
    data: RelativeScoringRecomputeJobData,
  ): Promise<void> {
    const normalizedData = this.normalizeJobData(data);
    if (!normalizedData) {
      this.logger.warn({
        message: 'Skipping invalid relative scoring recompute job payload.',
        data,
      });
      return;
    }

    await this.scoringResultService.recomputeQueuedRelativeScoring(
      normalizedData,
    );
  }

  /**
   * Validates and normalizes one recompute job payload.
   * @param data Raw job data from pg-boss.
   * @returns Normalized job data, or undefined when required fields are missing.
   */
  private normalizeJobData(
    data: RelativeScoringRecomputeJobData,
  ): RelativeScoringRecomputeJobData | undefined {
    const challengeId = data.challengeId?.trim();
    const submissionId = data.submissionId?.trim();
    const reviewTypeId = data.reviewTypeId?.trim();
    const testPhase = this.normalizeTestPhase(data.testPhase);

    if (!challengeId || !submissionId || !reviewTypeId) {
      return undefined;
    }

    return {
      challengeId,
      submissionId,
      reviewTypeId,
      testPhase,
      queuedAt: data.queuedAt?.trim() || new Date().toISOString(),
      reviewId: data.reviewId?.trim() || undefined,
      scorecardId: data.scorecardId?.trim() || undefined,
      reason: data.reason?.trim() || undefined,
    };
  }

  /**
   * Normalizes example/provisional/system phase names.
   * @param testPhase Raw phase value from the queue.
   * @returns Normalized phase string.
   */
  private normalizeTestPhase(testPhase: string | undefined): string {
    const normalized = (testPhase || '').trim().toLowerCase();

    if (normalized === 'example') {
      return 'example';
    }
    if (normalized === 'system' || normalized === 'final') {
      return 'system';
    }

    return 'provisional';
  }

  /**
   * Resolves the worker concurrency. The default of 1 keeps recompute writes
   * gentle; advisory locks still serialize same challenge/phase work if this is raised.
   * @returns Positive worker concurrency.
   * @throws Error when RELATIVE_SCORING_RECOMPUTE_WORKER_CONCURRENCY is invalid.
   */
  private getWorkerConcurrency(): number {
    return this.getPositiveIntegerEnv(
      'RELATIVE_SCORING_RECOMPUTE_WORKER_CONCURRENCY',
      1,
    );
  }

  /**
   * Resolves the pg-boss retry limit for recompute jobs.
   * @returns Positive retry count. Defaults to 1000.
   * @throws Error when RELATIVE_SCORING_RECOMPUTE_RETRY_LIMIT is invalid.
   */
  private getRetryLimit(): number {
    return this.getPositiveIntegerEnv(
      'RELATIVE_SCORING_RECOMPUTE_RETRY_LIMIT',
      1000,
    );
  }

  /**
   * Resolves the fixed retry delay for recompute jobs.
   * @returns Positive delay in seconds. Defaults to 60 seconds.
   * @throws Error when RELATIVE_SCORING_RECOMPUTE_RETRY_DELAY_SECONDS is invalid.
   */
  private getRetryDelaySeconds(): number {
    return this.getPositiveIntegerEnv(
      'RELATIVE_SCORING_RECOMPUTE_RETRY_DELAY_SECONDS',
      60,
    );
  }

  /**
   * Reads a positive integer environment variable with a default.
   * @param name Environment variable name.
   * @param defaultValue Value used when the env var is unset.
   * @returns Positive integer value.
   * @throws Error when the env var is present but not a positive integer.
   */
  private getPositiveIntegerEnv(name: string, defaultValue: number): number {
    const raw = process.env[name]?.trim();
    if (!raw) {
      return defaultValue;
    }

    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${name} must be a positive integer.`);
    }

    return parsed;
  }
}
