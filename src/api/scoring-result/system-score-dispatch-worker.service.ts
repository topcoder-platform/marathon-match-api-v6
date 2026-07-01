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
  ScoringResultService,
  SystemScoreDispatchResult,
} from './scoring-result.service';
import {
  SYSTEM_SCORE_DISPATCH_QUEUE,
  SystemScoreDispatchJobData,
} from './system-score-dispatch-scheduler.service';

/**
 * Consumes deferred SYSTEM scoring dispatch jobs. Capacity-limit failures are
 * thrown back to pg-boss so the same review is retried after the configured
 * delay instead of being dropped when the ECS scorer cap is full.
 */
@Injectable()
export class SystemScoreDispatchWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = LoggerService.forRoot(
    'SystemScoreDispatchWorkerService',
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
   * Starts the deferred SYSTEM dispatch worker.
   * @returns Promise that resolves after worker registration is complete.
   * @throws Error when pg-boss startup or worker registration fails.
   */
  async onModuleInit(): Promise<void> {
    if (this.pgBossDisabled) {
      this.logger.warn(
        'DISABLE_PG_BOSS=true, skipping system-score-dispatch worker startup.',
      );
      return;
    }

    this.pgBoss.on('error', this.handlePgBossError);
    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(SYSTEM_SCORE_DISPATCH_QUEUE, {
      retryLimit: this.getRetryLimit(),
      retryDelay: this.getRetryDelaySeconds(),
      retryBackoff: false,
    });

    this.workerId = await this.pgBoss.work<SystemScoreDispatchJobData>(
      SYSTEM_SCORE_DISPATCH_QUEUE,
      {
        teamSize: this.getWorkerConcurrency(),
        teamConcurrency: this.getWorkerConcurrency(),
      } as unknown as PgBoss.WorkOptions,
      async (
        jobOrJobs:
          | PgBoss.Job<SystemScoreDispatchJobData>[]
          | PgBoss.Job<SystemScoreDispatchJobData>,
      ) => {
        const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];

        for (const job of jobs) {
          await this.handleDispatchJob(job.data);
        }
      },
    );

    this.logger.log(
      `Registered pg-boss worker for ${SYSTEM_SCORE_DISPATCH_QUEUE} jobs.`,
    );
  }

  /**
   * Unregisters the dispatch worker during shutdown.
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
          'Unable to unregister system-score-dispatch pg-boss worker cleanly.',
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Attempts one deferred SYSTEM dispatch.
   * @param data Job payload with review, submission, and challenge identifiers.
   * @returns Promise that resolves after the scorer task launches or scoring is skipped.
   * @throws Error when dispatch still cannot launch; pg-boss will retry the job.
   */
  private async handleDispatchJob(
    data: SystemScoreDispatchJobData,
  ): Promise<void> {
    const normalizedData = this.normalizeJobData(data);
    if (!normalizedData) {
      this.logger.warn({
        message: 'Skipping invalid SYSTEM score dispatch job payload.',
        data,
      });
      return;
    }

    const result = await this.scoringResultService.triggerSystemScore(
      normalizedData.reviewId,
      normalizedData.submissionId,
      normalizedData.challengeId,
      {
        enqueueOnCapacityLimit: false,
      },
    );

    this.logDispatchResult(normalizedData, result);
  }

  /**
   * Validates and normalizes one dispatch job payload.
   * @param data Raw job data from pg-boss.
   * @returns Normalized job data, or undefined when required fields are missing.
   */
  private normalizeJobData(
    data: SystemScoreDispatchJobData,
  ): SystemScoreDispatchJobData | undefined {
    const challengeId = data.challengeId?.trim();
    const submissionId = data.submissionId?.trim();
    const reviewId = data.reviewId?.trim();

    if (!challengeId || !submissionId || !reviewId) {
      return undefined;
    }

    return {
      challengeId,
      submissionId,
      reviewId,
      queuedAt: data.queuedAt?.trim() || new Date().toISOString(),
      reason: data.reason?.trim() || undefined,
    };
  }

  /**
   * Writes a structured log for one completed deferred dispatch attempt.
   * @param data Normalized job payload.
   * @param result Dispatch result from ScoringResultService.
   */
  private logDispatchResult(
    data: SystemScoreDispatchJobData,
    result: SystemScoreDispatchResult,
  ): void {
    if ('skipped' in result && result.skipped) {
      this.logger.log({
        message: 'Deferred SYSTEM score dispatch completed as skipped.',
        challengeId: data.challengeId,
        submissionId: data.submissionId,
        reviewId: data.reviewId,
        reason: result.reason,
      });
      return;
    }

    if ('queued' in result && result.queued) {
      throw new Error(
        `Deferred SYSTEM score dispatch unexpectedly re-queued review ${data.reviewId}.`,
      );
    }

    if ('taskArn' in result) {
      this.logger.log({
        message: 'Deferred SYSTEM score dispatch launched ECS task.',
        challengeId: data.challengeId,
        submissionId: data.submissionId,
        reviewId: data.reviewId,
        taskArn: result.taskArn,
        taskId: result.taskId,
      });
    }
  }

  /**
   * Resolves the worker concurrency. The default of 1 keeps capacity retries
   * gentle while still letting successful jobs drain quickly one after another.
   * @returns Positive worker concurrency.
   * @throws Error when SYSTEM_SCORE_DISPATCH_WORKER_CONCURRENCY is invalid.
   */
  private getWorkerConcurrency(): number {
    return this.getPositiveIntegerEnv(
      'SYSTEM_SCORE_DISPATCH_WORKER_CONCURRENCY',
      1,
    );
  }

  /**
   * Resolves the pg-boss retry limit for deferred dispatch jobs.
   * @returns Positive retry count. Defaults to 10000.
   * @throws Error when SYSTEM_SCORE_DISPATCH_RETRY_LIMIT is invalid.
   */
  private getRetryLimit(): number {
    return this.getPositiveIntegerEnv(
      'SYSTEM_SCORE_DISPATCH_RETRY_LIMIT',
      10000,
    );
  }

  /**
   * Resolves the fixed retry delay for deferred dispatch jobs.
   * @returns Positive delay in seconds. Defaults to 300 seconds.
   * @throws Error when SYSTEM_SCORE_DISPATCH_RETRY_DELAY_SECONDS is invalid.
   */
  private getRetryDelaySeconds(): number {
    return this.getPositiveIntegerEnv(
      'SYSTEM_SCORE_DISPATCH_RETRY_DELAY_SECONDS',
      300,
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
