import { Inject, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';
import { PgBossLifecycleService } from 'src/shared/modules/pg-boss/pg-boss-lifecycle.service';

export const RELATIVE_SCORING_RECOMPUTE_QUEUE = 'relative-scoring-recompute';

export interface RelativeScoringRecomputeJobData {
  challengeId: string;
  submissionId: string;
  testPhase: string;
  reviewTypeId: string;
  queuedAt: string;
  reviewId?: string;
  scorecardId?: string;
  reason?: string;
}

/**
 * Persists deferred relative scoring recomputation requests after scorer
 * callbacks write their raw per-test results. Jobs are debounced by challenge
 * and phase for SYSTEM scoring so large result bursts do not run the expensive
 * latest-submission recompute once per callback.
 */
@Injectable()
export class RelativeScoringRecomputeSchedulerService {
  private readonly logger = LoggerService.forRoot(
    'RelativeScoringRecomputeSchedulerService',
  );
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly pgBossLifecycleService: PgBossLifecycleService,
  ) {}

  /**
   * Enqueues one relative scoring recomputation after the callback result has
   * been persisted.
   * @param data Challenge, phase, submission, and review context for the recompute.
   * @returns PgBoss job id for the queued recompute, or null when a singleton job already exists.
   * @throws Error when pg-boss is disabled or queue persistence fails.
   * Used by `ScoringResultService.processScoringResult` to keep scorer callback
   * latency independent from relative-score fan-out work.
   */
  async enqueueRelativeScoringRecompute(
    data: RelativeScoringRecomputeJobData,
  ): Promise<string | null> {
    const normalizedData = this.normalizeJobData(data);

    if (this.pgBossDisabled) {
      throw new Error(
        'DISABLE_PG_BOSS=true, cannot enqueue relative scoring recomputation.',
      );
    }

    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(RELATIVE_SCORING_RECOMPUTE_QUEUE, {
      retryLimit: this.getRetryLimit(),
      retryDelay: this.getRetryDelaySeconds(),
      retryBackoff: false,
    });

    const debounceSeconds = this.getDebounceSeconds();
    const jobId = await this.pgBoss.sendDebounced(
      RELATIVE_SCORING_RECOMPUTE_QUEUE,
      normalizedData,
      {
        retryLimit: this.getRetryLimit(),
        retryDelay: this.getRetryDelaySeconds(),
        retryBackoff: false,
        startAfter: this.getStartDelaySeconds(),
      },
      debounceSeconds,
      this.buildSingletonKey(normalizedData),
    );

    this.logger.log({
      message: 'Queued relative scoring recomputation.',
      jobId,
      challengeId: normalizedData.challengeId,
      submissionId: normalizedData.submissionId,
      reviewId: normalizedData.reviewId ?? null,
      testPhase: normalizedData.testPhase,
      debounceSeconds,
      reason: normalizedData.reason ?? null,
    });

    return jobId ?? null;
  }

  /**
   * Normalizes and validates relative recompute queue payload fields.
   * @param data Raw recompute job data.
   * @returns Normalized recompute job data.
   * @throws Error when required identifiers are missing.
   */
  private normalizeJobData(
    data: RelativeScoringRecomputeJobData,
  ): RelativeScoringRecomputeJobData {
    const challengeId = data.challengeId?.trim();
    const submissionId = data.submissionId?.trim();
    const reviewTypeId = data.reviewTypeId?.trim();
    const testPhase = this.normalizeTestPhase(data.testPhase);

    if (!challengeId || !submissionId || !reviewTypeId) {
      throw new Error(
        'Relative scoring recompute jobs require challengeId, submissionId, and reviewTypeId.',
      );
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
   * Builds a stable singleton key for one logical recompute burst.
   * @param data Normalized recompute job data.
   * @returns Singleton key used by pg-boss debouncing.
   */
  private buildSingletonKey(data: RelativeScoringRecomputeJobData): string {
    const keyParts = [data.challengeId, data.testPhase];
    if (data.testPhase !== 'system') {
      keyParts.push(data.submissionId);
    }

    return keyParts.join(':');
  }

  /**
   * Normalizes example/provisional/system phase names for queue keys.
   * @param testPhase Raw phase value from the scorer callback.
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
   * Resolves the debounce window for recompute jobs.
   * @returns Positive debounce window in seconds. Defaults to 15 seconds.
   * @throws Error when RELATIVE_SCORING_RECOMPUTE_DEBOUNCE_SECONDS is invalid.
   */
  private getDebounceSeconds(): number {
    return this.getPositiveIntegerEnv(
      'RELATIVE_SCORING_RECOMPUTE_DEBOUNCE_SECONDS',
      15,
    );
  }

  /**
   * Resolves the initial delay before a recompute job can run.
   * @returns Positive delay in seconds. Defaults to 10 seconds.
   * @throws Error when RELATIVE_SCORING_RECOMPUTE_START_DELAY_SECONDS is invalid.
   */
  private getStartDelaySeconds(): number {
    return this.getPositiveIntegerEnv(
      'RELATIVE_SCORING_RECOMPUTE_START_DELAY_SECONDS',
      10,
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
