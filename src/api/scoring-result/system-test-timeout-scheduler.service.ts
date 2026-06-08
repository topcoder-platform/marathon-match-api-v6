import { Inject, Injectable } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';
import { PgBossLifecycleService } from 'src/shared/modules/pg-boss/pg-boss-lifecycle.service';

export const SYSTEM_TEST_TIMEOUT_QUEUE = 'system-test-timeout';

export interface SystemTestTimeoutJobData {
  challengeId: string;
  submissionId: string;
  reviewId?: string;
  taskArn: string;
  cluster: string;
  testPhase: string;
  reviewTypeId: string;
  scorecardId?: string;
  timeoutMs: number;
  launchedAt: string;
}

/**
 * Schedules delayed timeout checks for SYSTEM scoring ECS tasks. Each job is
 * keyed by task ARN so repeated scheduling for the same task does not create
 * duplicate timeout checks.
 */
@Injectable()
export class SystemTestTimeoutSchedulerService {
  private readonly logger = LoggerService.forRoot(
    'SystemTestTimeoutSchedulerService',
  );
  private readonly pgBossDisabled = process.env.DISABLE_PG_BOSS === 'true';

  constructor(
    @Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss,
    private readonly pgBossLifecycleService: PgBossLifecycleService,
  ) {}

  /**
   * Schedules one delayed SYSTEM scoring timeout check.
   * @param data Timeout job payload with task, submission, and review context.
   * @param timeoutMs Delay in milliseconds before the timeout check runs.
   * @returns Promise that resolves after the job is queued, or immediately when pg-boss is disabled.
   */
  async scheduleSystemTestTimeout(
    data: SystemTestTimeoutJobData,
    timeoutMs: number,
  ): Promise<void> {
    const normalizedTimeoutMs = Number.isFinite(timeoutMs)
      ? Math.max(1, Math.floor(timeoutMs))
      : 86400000;

    if (this.pgBossDisabled) {
      this.logger.warn({
        message:
          'DISABLE_PG_BOSS=true, skipping SYSTEM test timeout scheduling.',
        challengeId: data.challengeId,
        submissionId: data.submissionId,
        taskArn: data.taskArn,
        timeoutMs: normalizedTimeoutMs,
      });
      return;
    }

    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(SYSTEM_TEST_TIMEOUT_QUEUE, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });

    const jobId = await this.pgBoss.send(SYSTEM_TEST_TIMEOUT_QUEUE, data, {
      startAfter: new Date(Date.now() + normalizedTimeoutMs),
      singletonKey: data.taskArn,
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });

    this.logger.log({
      message: 'Scheduled SYSTEM test timeout check.',
      jobId,
      challengeId: data.challengeId,
      submissionId: data.submissionId,
      taskArn: data.taskArn,
      timeoutMs: normalizedTimeoutMs,
    });
  }
}
