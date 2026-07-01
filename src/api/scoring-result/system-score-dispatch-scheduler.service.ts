import { Inject, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';
import { PgBossLifecycleService } from 'src/shared/modules/pg-boss/pg-boss-lifecycle.service';

export const SYSTEM_SCORE_DISPATCH_QUEUE = 'system-score-dispatch';

export interface SystemScoreDispatchJobData {
  challengeId: string;
  submissionId: string;
  reviewId: string;
  queuedAt: string;
  reason?: string;
}

/**
 * Persists deferred SYSTEM scoring dispatch requests when the active ECS scorer
 * task cap is full. Jobs are keyed by challenge/review/submission so replayed
 * review-open events do not create duplicate dispatch work for the same review.
 */
@Injectable()
export class SystemScoreDispatchSchedulerService {
  private readonly logger = LoggerService.forRoot(
    'SystemScoreDispatchSchedulerService',
  );
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly pgBossLifecycleService: PgBossLifecycleService,
  ) {}

  /**
   * Enqueues one SYSTEM scoring dispatch for later worker retry.
   * @param data Review/submission/challenge identifiers for the dispatch job.
   * @returns PgBoss job id for the queued dispatch.
   * @throws Error when pg-boss is disabled or queue persistence fails.
   * Used by `ScoringResultService.triggerSystemScore` after ECS reports the
   * scorer concurrency cap is already full.
   */
  async enqueueSystemScoreDispatch(
    data: SystemScoreDispatchJobData,
  ): Promise<string | null> {
    const normalizedData = this.normalizeJobData(data);

    if (this.pgBossDisabled) {
      throw new Error(
        'DISABLE_PG_BOSS=true, cannot enqueue deferred SYSTEM scoring dispatch.',
      );
    }

    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(SYSTEM_SCORE_DISPATCH_QUEUE, {
      retryLimit: this.getRetryLimit(),
      retryDelay: this.getRetryDelaySeconds(),
      retryBackoff: false,
    });

    const jobId = await this.pgBoss.send(
      SYSTEM_SCORE_DISPATCH_QUEUE,
      normalizedData,
      {
        singletonKey: this.buildSingletonKey(normalizedData),
        retryLimit: this.getRetryLimit(),
        retryDelay: this.getRetryDelaySeconds(),
        retryBackoff: false,
      },
    );

    this.logger.log({
      message: 'Queued deferred SYSTEM score dispatch.',
      jobId,
      challengeId: normalizedData.challengeId,
      submissionId: normalizedData.submissionId,
      reviewId: normalizedData.reviewId,
      reason: normalizedData.reason ?? null,
    });

    return jobId ?? null;
  }

  /**
   * Normalizes and validates dispatch queue payload fields.
   * @param data Raw dispatch job data.
   * @returns Normalized dispatch job data.
   * @throws Error when required identifiers are missing.
   */
  private normalizeJobData(
    data: SystemScoreDispatchJobData,
  ): SystemScoreDispatchJobData {
    const challengeId = data.challengeId?.trim();
    const submissionId = data.submissionId?.trim();
    const reviewId = data.reviewId?.trim();

    if (!challengeId || !submissionId || !reviewId) {
      throw new Error(
        'SYSTEM score dispatch jobs require challengeId, submissionId, and reviewId.',
      );
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
   * Builds a stable singleton key for one logical SYSTEM dispatch.
   * @param data Normalized dispatch job data.
   * @returns Singleton key used by pg-boss.
   */
  private buildSingletonKey(data: SystemScoreDispatchJobData): string {
    return [data.challengeId, data.reviewId, data.submissionId].join(':');
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
