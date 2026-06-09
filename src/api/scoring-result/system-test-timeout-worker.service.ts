import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Task } from '@aws-sdk/client-ecs';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { EcsService } from 'src/shared/modules/global/ecs.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PG_BOSS_TOKEN } from 'src/shared/modules/pg-boss/pg-boss.module';
import { PgBossLifecycleService } from 'src/shared/modules/pg-boss/pg-boss-lifecycle.service';
import { ScoringResultService } from './scoring-result.service';
import {
  SYSTEM_TEST_TIMEOUT_QUEUE,
  SystemTestTimeoutJobData,
} from './system-test-timeout-scheduler.service';

/**
 * Consumes delayed SYSTEM scoring timeout checks, stops still-active ECS runner
 * tasks, and writes a failed timed-out review summation.
 */
@Injectable()
export class SystemTestTimeoutWorkerService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = LoggerService.forRoot(
    'SystemTestTimeoutWorkerService',
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
    private readonly ecsService: EcsService,
    private readonly scoringResultService: ScoringResultService,
  ) {}

  /**
   * Starts the timeout queue worker.
   * @returns Promise that resolves after worker registration is complete.
   * @throws Error when pg-boss startup or worker registration fails.
   */
  async onModuleInit(): Promise<void> {
    if (this.pgBossDisabled) {
      this.logger.warn(
        'DISABLE_PG_BOSS=true, skipping system-test-timeout worker startup.',
      );
      return;
    }

    this.pgBoss.on('error', this.handlePgBossError);
    await this.pgBossLifecycleService.ensureStarted();
    await this.pgBoss.createQueue(SYSTEM_TEST_TIMEOUT_QUEUE, {
      retryLimit: 3,
      retryDelay: 60,
      retryBackoff: true,
    });

    this.workerId = await this.pgBoss.work<SystemTestTimeoutJobData>(
      SYSTEM_TEST_TIMEOUT_QUEUE,
      {
        teamSize: 1,
        teamConcurrency: 1,
      } as unknown as PgBoss.WorkOptions,
      async (
        jobOrJobs:
          | PgBoss.Job<SystemTestTimeoutJobData>[]
          | PgBoss.Job<SystemTestTimeoutJobData>,
      ) => {
        const jobs = Array.isArray(jobOrJobs) ? jobOrJobs : [jobOrJobs];

        for (const job of jobs) {
          await this.handleTimeoutJob(job.data);
        }
      },
    );

    this.logger.log(
      `Registered pg-boss worker for ${SYSTEM_TEST_TIMEOUT_QUEUE} jobs.`,
    );
  }

  /**
   * Unregisters the timeout queue worker during shutdown.
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
          'Unable to unregister system-test-timeout pg-boss worker cleanly.',
        workerId: this.workerId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Handles a delayed timeout job by checking current task/review state before failing it.
   * @param data Job payload with ECS task and SYSTEM review context.
   * @returns Promise that resolves when no action is needed or the timeout failure is persisted.
   */
  private async handleTimeoutJob(
    data: SystemTestTimeoutJobData,
  ): Promise<void> {
    const normalizedData = this.normalizeJobData(data);
    if (!normalizedData) {
      this.logger.warn({
        message: 'Skipping invalid SYSTEM test timeout job payload.',
        data,
      });
      return;
    }

    const task = await this.ecsService.describeTask(
      normalizedData.taskArn,
      normalizedData.cluster,
    );
    if (this.isStoppedTask(task)) {
      this.logger.log({
        message:
          'SYSTEM test timeout check skipped because ECS task is already stopped.',
        challengeId: normalizedData.challengeId,
        submissionId: normalizedData.submissionId,
        taskArn: normalizedData.taskArn,
        lastStatus: task.lastStatus,
        desiredStatus: task.desiredStatus,
      });
      return;
    }

    const scoringComplete =
      await this.scoringResultService.isPhaseScoringComplete(
        normalizedData.challengeId,
        normalizedData.submissionId,
        normalizedData.testPhase,
      );
    if (scoringComplete) {
      this.logger.log({
        message:
          'SYSTEM test timeout check skipped because review summation is already complete.',
        challengeId: normalizedData.challengeId,
        submissionId: normalizedData.submissionId,
        taskArn: normalizedData.taskArn,
      });
      return;
    }

    try {
      await this.ecsService.stopTask(
        normalizedData.taskArn,
        `Marathon Match SYSTEM scoring timed out after ${normalizedData.timeoutMs} ms.`,
        normalizedData.cluster,
      );
    } catch (error) {
      this.logger.warn({
        message:
          'Unable to stop ECS scorer task during timeout handling; continuing to fail review summation.',
        challengeId: normalizedData.challengeId,
        submissionId: normalizedData.submissionId,
        taskArn: normalizedData.taskArn,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await this.scoringResultService.markSystemTestTimedOut(normalizedData);
  }

  /**
   * Validates and normalizes a timeout job payload.
   * @param data Raw job data from pg-boss.
   * @returns Normalized job data, or undefined when required fields are missing.
   */
  private normalizeJobData(
    data: SystemTestTimeoutJobData,
  ): SystemTestTimeoutJobData | undefined {
    const challengeId = data.challengeId?.trim();
    const submissionId = data.submissionId?.trim();
    const taskArn = data.taskArn?.trim();
    const cluster = data.cluster?.trim();
    const reviewTypeId = data.reviewTypeId?.trim();
    const testPhase = data.testPhase?.trim() || 'system';
    const timeoutMs = Number.isFinite(data.timeoutMs)
      ? Math.max(1, Math.floor(data.timeoutMs))
      : 86400000;

    if (
      !challengeId ||
      !submissionId ||
      !taskArn ||
      !cluster ||
      !reviewTypeId
    ) {
      return undefined;
    }

    return {
      ...data,
      challengeId,
      submissionId,
      reviewId: data.reviewId?.trim() || undefined,
      taskArn,
      cluster,
      testPhase,
      reviewTypeId,
      scorecardId: data.scorecardId?.trim() || undefined,
      timeoutMs,
    };
  }

  /**
   * Checks whether ECS reports a task as terminal.
   * @param task ECS task description.
   * @returns True when the task is already stopped.
   */
  private isStoppedTask(task: Task): boolean {
    return task.lastStatus?.trim().toUpperCase() === 'STOPPED';
  }
}
