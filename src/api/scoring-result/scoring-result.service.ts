import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import {
  CompilationStatus,
  PhaseConfigType,
  Prisma,
  ScoreDirection,
} from '@prisma/client';
import { createHash } from 'crypto';
import { firstValueFrom } from 'rxjs';
import {
  EcsService,
  MarathonMatchScorerTaskLaunchResult,
} from 'src/shared/modules/global/ecs.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import {
  ScoringCompletionStatus,
  ScoringCompletionEmailService,
  SubmissionScoringCompletionEmailDetails,
  SystemScoringCompletionEmailDetails,
} from './scoring-completion-email.service';
import {
  SystemTestTimeoutJobData,
  SystemTestTimeoutSchedulerService,
} from './system-test-timeout-scheduler.service';

export interface ScoringResultCallbackPayload {
  challengeId: string;
  submissionId: string;
  score: number;
  testPhase: string;
  reviewTypeId: string;
  reviewId?: string;
  validationRunId?: string;
  scorecardId?: string;
  metadata?: Record<string, unknown>;
  currentReview?: Record<string, unknown>;
  impactedReviews?: Record<string, unknown>[];
}

export enum ScoringTestStatus {
  InProgress = 'IN PROGRESS',
  Success = 'SUCCESS',
  Failed = 'FAILED',
}

const MAX_REVIEW_SCORE_LABEL = '9223372036854775807';
const MAX_REVIEW_SCORE = Number(MAX_REVIEW_SCORE_LABEL);

export interface ScoringProgressCallbackPayload {
  challengeId: string;
  submissionId: string;
  testPhase: string;
  reviewTypeId: string;
  progress: number;
  status: ScoringTestStatus;
  reviewId?: string;
  validationRunId?: string;
  scorecardId?: string;
  completedTests?: number;
  totalTests?: number;
  failedTests?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

export interface SkippedSubmissionScoringInput {
  challengeId: string;
  submissionId: string;
  testPhase: string;
  reason: string;
  reviewId?: string;
  scorecardId?: string;
  details?: Record<string, unknown>;
}

export interface SkippedSystemScoreDispatchResult {
  skipped: true;
  reason: string;
  reviewId: string;
  submissionId: string;
}

export type SystemScoreDispatchResult =
  | MarathonMatchScorerTaskLaunchResult
  | SkippedSystemScoreDispatchResult;

interface ReviewSummationPayload {
  submissionId: string;
  aggregateScore: number;
  isPassing: boolean;
  reviewedDate: string;
  scorecardId?: string;
  isFinal?: boolean;
  isProvisional?: boolean;
  isExample?: boolean;
  metadata?: Record<string, unknown>;
}

interface SummationBuildInput {
  submissionId: string;
  score: number;
  scorecardId?: string;
  metadata?: Record<string, unknown>;
  preserveReviewedDate?: boolean;
  reviewObject?: Record<string, unknown>;
  testPhase: string;
}

interface RelativeScoringSettings {
  challengeId?: string;
  submissionApiUrl?: string;
  enabled: boolean;
  scoreDirection: ScoreDirection;
}

interface RelativeScoringLockIds {
  classId: number;
  objectId: number;
}

interface ScoringResultConfigSummary {
  challengeId: string;
  name: string;
  submissionApiUrl: string;
  relativeScoringEnabled: boolean;
  scoreDirection: ScoreDirection;
}

interface RelativeTestScoreEntry {
  testcase: string;
  score: number;
  error?: string;
}

interface RelativeReviewRecord {
  submissionId: string;
  memberKey?: string;
  createdAt?: string;
  reviewObject: Record<string, unknown>;
  metadata: Record<string, unknown>;
  rawTestScores: RelativeTestScoreEntry[];
}

interface RelativeReviewPayload {
  reviewObject: Record<string, unknown>;
  payload: ReviewSummationPayload;
}

interface SystemReviewCompletionContext {
  challengeId: string;
  submissionId: string;
  scorecardId?: string;
}

interface CompletedPhaseScoringResult {
  aggregateScore: number;
  status: ScoringCompletionStatus;
}

interface LatestMemberSubmissionCandidate {
  submission: Record<string, unknown>;
  memberKey: string;
  submittedDate?: string;
  isLatest?: boolean;
  sequence: number;
}

interface LatestRelativeReviewCandidate extends LatestMemberSubmissionCandidate {
  submissionId: string;
  memberId?: string;
  reviewObject: Record<string, unknown>;
}

interface SubmissionMemberIdentity {
  memberHandle?: string;
  memberId?: string;
  userId?: string;
}

interface SystemScoringCompletionCandidate {
  submissionId: string;
  memberHandle?: string;
  memberId?: string;
  userId?: string;
  scoringResult: CompletedPhaseScoringResult;
}

/**
 * Applies marathon-match review summation updates based on scorer callback data.
 * Relative-score propagation is handled here to keep ECS runner logic lightweight.
 */
@Injectable()
export class ScoringResultService {
  private readonly logger = LoggerService.forRoot('ScoringResultService');
  private readonly scorecardIdLookupCache = new Map<string, string | null>();
  private readonly challengeNameLookupCache = new Map<string, string>();
  private readonly challengeApiBaseUrl =
    process.env.CHALLENGE_API_URL?.replace(/\/+$/, '') ||
    'https://api.topcoder-dev.com';

  constructor(
    private readonly httpService: HttpService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
    private readonly ecsService: EcsService,
    @Optional()
    private readonly scoringCompletionEmailService?: ScoringCompletionEmailService,
    @Optional()
    private readonly systemTestTimeoutSchedulerService?: SystemTestTimeoutSchedulerService,
  ) {}

  /**
   * Processes one scorer callback payload after verifying the challenge config exists,
   * then writes terminal summations before completing any SYSTEM review.
   */
  async processScoringResult(
    payload: ScoringResultCallbackPayload,
  ): Promise<void> {
    this.validateReviewScore(payload.score, 'Scoring callback score');

    const normalizedPhase = this.normalizeTestPhase(payload.testPhase);
    const config = await this.requireScoringResultConfig(payload.challengeId);
    const validationRunId = this.asString(payload.validationRunId)?.trim();
    if (validationRunId) {
      await this.recordValidationScoringResult(
        validationRunId,
        payload,
        normalizedPhase,
      );
      return;
    }

    const token = await this.m2mService.getM2MToken();

    if (!token) {
      throw new Error('Unable to get M2M token for review summation upsert.');
    }

    const fallbackMetadata = this.withFinalTestProgressMetadata(
      this.normalizeMetadata(
        payload.metadata,
        normalizedPhase,
        payload.reviewTypeId,
      ),
      payload.score,
    );
    const fallbackScorecardId = await this.resolveScorecardId(
      token,
      payload.scorecardId,
    );

    const relativeScoringSettings = this.resolveRelativeScoringSettings(
      payload,
      fallbackMetadata,
      config,
    );
    if (relativeScoringSettings.enabled) {
      const currentRelativeScore = await this.processRelativeScoring(
        token,
        payload,
        normalizedPhase,
        fallbackMetadata,
        fallbackScorecardId,
        relativeScoringSettings,
      );
      if (currentRelativeScore !== undefined) {
        await this.notifyScoringCompletionEmailIfReady(
          token,
          payload,
          normalizedPhase,
          config,
        );
        return;
      }
    }

    if (
      payload.currentReview &&
      Object.keys(payload.currentReview).length > 0
    ) {
      const currentReviewScore = this.resolveReviewScore(
        this.asRecord(payload.currentReview),
        normalizedPhase,
        payload.score,
      );

      await this.upsertFromLegacyReviewPayload(token, {
        legacyReview: payload.currentReview,
        fallbackSubmissionId: payload.submissionId,
        fallbackScore: payload.score,
        fallbackScorecardId,
        fallbackMetadata,
        testPhase: normalizedPhase,
      });

      for (const impactedReview of payload.impactedReviews ?? []) {
        await this.upsertFromLegacyReviewPayload(token, {
          legacyReview: impactedReview,
          fallbackSubmissionId: payload.submissionId,
          fallbackScore: payload.score,
          fallbackScorecardId,
          fallbackMetadata,
          testPhase: normalizedPhase,
        });
      }

      await this.completeSystemReviewIfNeeded(
        token,
        payload.reviewId,
        currentReviewScore,
        normalizedPhase,
        {
          challengeId: payload.challengeId,
          scorecardId: fallbackScorecardId,
          submissionId: payload.submissionId,
        },
      );

      await this.notifyScoringCompletionEmailIfReady(
        token,
        payload,
        normalizedPhase,
        config,
      );
      return;
    }

    const reviewPayload = this.buildSummationPayload({
      submissionId: payload.submissionId,
      score: payload.score,
      scorecardId: fallbackScorecardId,
      metadata: fallbackMetadata,
      testPhase: normalizedPhase,
    });

    await this.upsertReviewSummation(token, normalizedPhase, reviewPayload);
    await this.completeSystemReviewIfNeeded(
      token,
      payload.reviewId,
      reviewPayload.aggregateScore,
      normalizedPhase,
      {
        challengeId: payload.challengeId,
        scorecardId: fallbackScorecardId,
        submissionId: payload.submissionId,
      },
    );
    await this.notifyScoringCompletionEmailIfReady(
      token,
      payload,
      normalizedPhase,
      config,
    );
  }

  /**
   * Processes one runner progress callback and creates or updates the phase review
   * summation with progress metadata. The review-api schema stores this Marathon
   * Match-specific state in `metadata.testProgress` and `metadata.testStatus`.
   */
  async processScoringProgress(
    payload: ScoringProgressCallbackPayload,
  ): Promise<void> {
    const normalizedPhase = this.normalizeTestPhase(payload.testPhase);
    await this.requireScoringResultConfig(payload.challengeId);
    const validationRunId = this.asString(payload.validationRunId)?.trim();
    if (validationRunId) {
      await this.recordValidationScoringProgress(
        validationRunId,
        payload,
        normalizedPhase,
      );
      return;
    }

    const token = await this.m2mService.getM2MToken();

    if (!token) {
      throw new Error('Unable to get M2M token for review summation progress.');
    }

    const fallbackScorecardId = await this.resolveScorecardId(
      token,
      payload.scorecardId,
    );
    const metadata = this.withTestProgressMetadata(
      this.normalizeMetadata(
        payload.metadata,
        normalizedPhase,
        payload.reviewTypeId,
      ),
      {
        completedTests: payload.completedTests,
        failedTests: payload.failedTests,
        message: payload.message,
        progress: payload.progress,
        reviewId: payload.reviewId,
        status: payload.status,
        totalTests: payload.totalTests,
      },
    );

    const reviewPayload = this.buildSummationPayload({
      submissionId: payload.submissionId,
      score: this.progressPlaceholderScore(payload.status),
      scorecardId: fallbackScorecardId,
      metadata,
      testPhase: normalizedPhase,
    });

    await this.upsertReviewSummation(token, normalizedPhase, reviewPayload);
  }

  /**
   * Stores the final scorer callback on an isolated validation run without
   * creating or updating Review API summations.
   * @param validationRunId Validation run created by Score Operations upload.
   * @param payload Runner callback payload containing score and scorer metadata.
   * @param normalizedPhase Normalized example/provisional/system phase name.
   * @returns Promise that resolves when the validation run has been updated.
   * @throws NotFoundException When the validation run does not exist for the callback challenge.
   * Used by `processScoringResult` when the ECS runner includes `validationRunId`.
   */
  private async recordValidationScoringResult(
    validationRunId: string,
    payload: ScoringResultCallbackPayload,
    normalizedPhase: string,
  ): Promise<void> {
    const metadata = this.withFinalTestProgressMetadata(
      this.normalizeMetadata(
        payload.metadata,
        normalizedPhase,
        payload.reviewTypeId,
      ),
      payload.score,
    );
    const existingRun = await this.prisma.testSubmissionRun.findFirst({
      where: {
        id: validationRunId,
        challengeId: payload.challengeId,
      },
      select: {
        id: true,
      },
    });

    if (!existingRun) {
      throw new NotFoundException(
        `Validation submission run ${validationRunId} not found for challenge ${payload.challengeId}.`,
      );
    }

    await this.prisma.testSubmissionRun.update({
      where: { id: validationRunId },
      data: {
        status: ScoringTestStatus.Success,
        score: payload.score,
        message: 'Scoring complete.',
        metadata: metadata as Prisma.InputJsonValue,
        currentReview: this.toOptionalJson(payload.currentReview),
        impactedReviews: this.toOptionalJson(payload.impactedReviews),
        progress: 1,
        completedTests:
          this.countCompletedTestScores(metadata) ||
          this.resolveTotalTests(metadata) ||
          undefined,
        totalTests: this.resolveTotalTests(metadata),
        failedTests: this.countFailedTestScores(metadata),
        completedAt: new Date(),
      },
    });
  }

  /**
   * Stores an intermediate runner progress callback on an isolated validation run
   * without creating or updating Review API summations.
   * @param validationRunId Validation run created by Score Operations upload.
   * @param payload Runner progress payload.
   * @param normalizedPhase Normalized example/provisional/system phase name.
   * @returns Promise that resolves when the validation run has been updated.
   * @throws NotFoundException When the validation run does not exist for the callback challenge.
   * Used by `processScoringProgress` when the ECS runner includes `validationRunId`.
   */
  private async recordValidationScoringProgress(
    validationRunId: string,
    payload: ScoringProgressCallbackPayload,
    normalizedPhase: string,
  ): Promise<void> {
    const metadata = this.withTestProgressMetadata(
      this.normalizeMetadata(
        payload.metadata,
        normalizedPhase,
        payload.reviewTypeId,
      ),
      {
        completedTests: payload.completedTests,
        failedTests: payload.failedTests,
        message: payload.message,
        progress: payload.progress,
        reviewId: payload.reviewId,
        status: payload.status,
        totalTests: payload.totalTests,
      },
    );
    const existingRun = await this.prisma.testSubmissionRun.findFirst({
      where: {
        id: validationRunId,
        challengeId: payload.challengeId,
      },
      select: {
        id: true,
      },
    });

    if (!existingRun) {
      throw new NotFoundException(
        `Validation submission run ${validationRunId} not found for challenge ${payload.challengeId}.`,
      );
    }

    await this.prisma.testSubmissionRun.update({
      where: { id: validationRunId },
      data: {
        status:
          payload.status === ScoringTestStatus.Failed
            ? ScoringTestStatus.Failed
            : ScoringTestStatus.InProgress,
        message: payload.message,
        metadata: metadata as Prisma.InputJsonValue,
        progress: this.clampProgress(payload.progress),
        completedTests: this.normalizeNonNegativeInteger(
          payload.completedTests,
        ),
        totalTests: this.normalizeNonNegativeInteger(payload.totalTests),
        failedTests: this.normalizeNonNegativeInteger(payload.failedTests),
        completedAt:
          payload.status === ScoringTestStatus.Failed ? new Date() : undefined,
      },
    });
  }

  /**
   * Persists a terminal failed review summation for a submission that should not
   * be dispatched to the runner. Used when preflight checks, such as virus scan
   * status, determine that example, provisional, or SYSTEM scoring must be skipped.
   * @param input Challenge, submission, phase, and skip context to write.
   * @returns Promise that resolves after the failed summation has been created or updated.
   * @throws NotFoundException When the Marathon Match config cannot be found.
   * @throws Error When auth or review-api persistence fails.
   */
  async markSubmissionScoringSkipped(
    input: SkippedSubmissionScoringInput,
  ): Promise<void> {
    const normalizedPhase = this.normalizeTestPhase(input.testPhase);
    await this.requireScoringResultConfig(input.challengeId);
    const token = await this.m2mService.getM2MToken();

    if (!token) {
      throw new Error('Unable to get M2M token for skipped scoring marker.');
    }

    const reviewTypeId = process.env.REVIEW_TYPE_ID?.trim();
    const fallbackScorecardId = await this.resolveScorecardId(
      token,
      input.scorecardId,
    );
    const metadata = this.withTestProgressMetadata(
      this.normalizeMetadata(
        {
          challengeId: input.challengeId,
          marathonMatchScoringSkipped: true,
          marathonMatchScoringSkipReason: input.reason,
          ...(input.details && Object.keys(input.details).length > 0
            ? { marathonMatchScoringSkipDetails: input.details }
            : {}),
        },
        normalizedPhase,
        reviewTypeId,
      ),
      {
        completedTests: 0,
        failedTests: 1,
        message: input.reason,
        progress: 1,
        reviewId: input.reviewId,
        status: ScoringTestStatus.Failed,
        totalTests: 0,
      },
    );
    const reviewPayload = this.buildSummationPayload({
      submissionId: input.submissionId,
      score: -1,
      scorecardId: fallbackScorecardId,
      metadata,
      testPhase: normalizedPhase,
    });

    await this.upsertReviewSummation(token, normalizedPhase, reviewPayload);
    await this.completeSystemReviewIfNeeded(
      token,
      input.reviewId,
      reviewPayload.aggregateScore,
      normalizedPhase,
      {
        challengeId: input.challengeId,
        scorecardId: fallbackScorecardId,
        submissionId: input.submissionId,
      },
    );
  }

  /**
   * Checks whether a phase review summation has reached a terminal state.
   * Used by the SYSTEM timeout worker before stopping a runner task so a delayed
   * timeout job cannot overwrite an already completed success or failure.
   * @param challengeId Challenge identifier that owns the submission.
   * @param submissionId Submission identifier to inspect.
   * @param testPhase Example, provisional, or system phase name.
   * @returns True when any matching review summation is complete.
   */
  async isPhaseScoringComplete(
    challengeId: string,
    submissionId: string,
    testPhase: string,
  ): Promise<boolean> {
    const normalizedPhase = this.normalizeTestPhase(testPhase);
    await this.requireScoringResultConfig(challengeId);
    const token = await this.m2mService.getM2MToken();

    if (!token) {
      throw new Error('Unable to get M2M token for review summation lookup.');
    }

    const existingReviews = await this.findExistingReviewSummations(
      token,
      submissionId,
      normalizedPhase,
    );

    return existingReviews.some((review) =>
      Boolean(this.resolveCompletedPhaseScoringResult(review)),
    );
  }

  /**
   * Persists a failed SYSTEM review summation caused by the total timeout guard.
   * The summation metadata includes `timed_out: true` so downstream consumers can
   * distinguish timeout failures from runner/tester failures.
   * @param data Timeout job data containing challenge, submission, review, and task context.
   * @returns Promise that resolves after the failed scoring result is processed.
   */
  async markSystemTestTimedOut(data: SystemTestTimeoutJobData): Promise<void> {
    const timeoutMs = this.resolveSystemTestTimeout(data.timeoutMs);

    await this.processScoringResult({
      challengeId: data.challengeId,
      submissionId: data.submissionId,
      score: -1,
      testPhase: 'system',
      reviewTypeId: data.reviewTypeId,
      reviewId: data.reviewId,
      scorecardId: data.scorecardId,
      metadata: {
        timed_out: true,
        timeoutMs,
        taskArn: data.taskArn,
        timeoutMessage: `SYSTEM scoring timed out after ${timeoutMs} ms.`,
      },
    });
  }

  /**
   * Dispatches the SYSTEM scorer task for a pending Marathon Match review.
   * @param reviewId Review identifier created in review-api.
   * @param submissionId Submission identifier to score.
   * @param challengeId Challenge identifier used to resolve Marathon Match config.
   * @returns ECS launch metadata, or a skipped result after writing a failed summation.
   */
  async triggerSystemScore(
    reviewId: string,
    submissionId: string,
    challengeId: string,
  ): Promise<SystemScoreDispatchResult> {
    const config = await this.prisma.marathonMatchConfig.findUnique({
      where: { challengeId },
      include: {
        phaseConfigs: true,
        tester: {
          select: {
            id: true,
            compilationStatus: true,
            compilationError: true,
          },
        },
      },
    });

    if (!config) {
      throw new NotFoundException(
        `Marathon match config with challenge ID ${challengeId} not found.`,
      );
    }

    if (config.active === false) {
      throw new BadRequestException(
        `Marathon match config ${challengeId} is inactive. SYSTEM scoring dispatch requires an active configuration.`,
      );
    }

    if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
      const compilationError = config.tester.compilationError?.trim();
      throw new BadRequestException(
        `Tester ${config.tester.id} for challenge ${challengeId} is not ready for SYSTEM scoring. Current compilation status: ${config.tester.compilationStatus}.${compilationError ? ` compilationError: ${compilationError}` : ''}`,
      );
    }

    const systemPhaseConfig = config.phaseConfigs.find(
      (phaseConfig) => phaseConfig.configType === PhaseConfigType.SYSTEM,
    );
    if (!systemPhaseConfig) {
      throw new BadRequestException(
        `Marathon match config ${challengeId} requires a SYSTEM phase config for system scoring dispatch.`,
      );
    }

    const submissionApiBaseUrl =
      process.env.SUBMISSION_API_URL?.trim() || config.submissionApiUrl?.trim();
    if (!submissionApiBaseUrl) {
      throw new Error(
        `Submission API URL is not configured for challenge ${challengeId}.`,
      );
    }

    const token = await this.m2mService.getM2MToken();
    if (!token) {
      throw new Error(
        'Unable to get M2M token for SYSTEM scoring submission preflight.',
      );
    }

    const submission = await this.fetchSubmissionById(
      token,
      submissionApiBaseUrl,
      submissionId,
    );
    if (!this.isSubmissionCleanForScoring(submission)) {
      const reason =
        'Marathon Match SYSTEM scoring skipped because the submission has not passed virus scanning.';
      await this.markSubmissionScoringSkipped({
        challengeId,
        details: {
          virusScan: submission?.virusScan ?? null,
        },
        reason,
        reviewId,
        scorecardId: config.reviewScorecardId,
        submissionId,
        testPhase: 'system',
      });
      this.logger.log({
        message:
          'Skipped Marathon Match SYSTEM score dispatch because submission is not virus-scanned.',
        challengeId,
        submissionId,
        reviewId,
        virusScan: submission?.virusScan ?? null,
      });

      return {
        skipped: true,
        reason,
        reviewId,
        submissionId,
      };
    }

    const launchResult = await this.ecsService.launchScorerTask(
      challengeId,
      submissionId,
      {
        taskDefinitionName: config.taskDefinitionName,
        taskDefinitionVersion: config.taskDefinitionVersion,
      },
      {
        configType: systemPhaseConfig.configType,
        startSeed: systemPhaseConfig.startSeed,
        numberOfTests: systemPhaseConfig.numberOfTests,
      },
      reviewId,
    );
    const systemTestTimeout = this.resolveSystemTestTimeout(
      config.systemTestTimeout,
    );
    await this.scheduleSystemScoringTimeout({
      challengeId,
      submissionId,
      reviewId,
      scorecardId: config.reviewScorecardId,
      taskArn: launchResult.taskArn,
      cluster: launchResult.cluster,
      timeoutMs: systemTestTimeout,
    });

    this.logger.log({
      message: 'Triggered Marathon Match SYSTEM score dispatch.',
      challengeId,
      submissionId,
      reviewId,
      taskArn: launchResult.taskArn,
      taskId: launchResult.taskId,
      systemTestTimeout,
    });

    return launchResult;
  }

  /**
   * Schedules a delayed timeout guard for a launched SYSTEM scorer task.
   * @param args Scoring task context produced by ECS launch.
   * @returns Promise that resolves after scheduling or when timeout scheduling is unavailable.
   */
  private async scheduleSystemScoringTimeout(args: {
    challengeId: string;
    submissionId: string;
    reviewId?: string;
    scorecardId?: string;
    taskArn: string;
    cluster: string;
    timeoutMs: number;
  }): Promise<void> {
    if (!this.systemTestTimeoutSchedulerService) {
      this.logger.warn({
        message:
          'SYSTEM test timeout scheduler is unavailable; timeout guard was not scheduled.',
        challengeId: args.challengeId,
        submissionId: args.submissionId,
        taskArn: args.taskArn,
      });
      return;
    }

    const reviewTypeId = process.env.REVIEW_TYPE_ID?.trim();
    if (!reviewTypeId) {
      this.logger.warn({
        message:
          'REVIEW_TYPE_ID is not configured; SYSTEM test timeout guard was not scheduled.',
        challengeId: args.challengeId,
        submissionId: args.submissionId,
        taskArn: args.taskArn,
      });
      return;
    }

    try {
      await this.systemTestTimeoutSchedulerService.scheduleSystemTestTimeout(
        {
          challengeId: args.challengeId,
          submissionId: args.submissionId,
          reviewId: args.reviewId,
          taskArn: args.taskArn,
          cluster: args.cluster,
          testPhase: 'system',
          reviewTypeId,
          scorecardId: args.scorecardId,
          timeoutMs: args.timeoutMs,
          launchedAt: new Date().toISOString(),
        },
        args.timeoutMs,
      );
    } catch (error) {
      this.logger.error({
        message:
          'Failed to schedule SYSTEM test timeout guard after ECS launch.',
        challengeId: args.challengeId,
        submissionId: args.submissionId,
        taskArn: args.taskArn,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Normalizes configured total SYSTEM scoring timeout values.
   * @param value Candidate timeout in milliseconds.
   * @returns Positive integer timeout in milliseconds, defaulting to 24 hours.
   */
  private resolveSystemTestTimeout(value: unknown): number {
    const parsed =
      typeof value === 'number'
        ? value
        : Number.parseInt(this.asString(value) ?? '', 10);

    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : 86400000;
  }

  /**
   * Recomputes relative scores for the latest submission from each member while
   * holding a challenge/phase advisory lock for the read-compute-write cycle.
   * Writes recomputed summations before completing the current SYSTEM review.
   * Returns undefined when relative scoring cannot be applied and the caller
   * should fall back to direct review upserts.
   */
  private async processRelativeScoring(
    token: string,
    payload: ScoringResultCallbackPayload,
    testPhase: string,
    fallbackMetadata: Record<string, unknown>,
    fallbackScorecardId: string | undefined,
    settings: RelativeScoringSettings,
  ): Promise<number | undefined> {
    const challengeId = settings.challengeId;
    const submissionApiUrl = settings.submissionApiUrl;
    if (!challengeId || !submissionApiUrl) {
      this.logger.warn({
        message:
          'Relative scoring is enabled but challenge context is incomplete. Falling back to direct review upsert.',
        challengeId: challengeId ?? null,
        submissionApiUrl: submissionApiUrl ?? null,
        submissionId: payload.submissionId,
        testPhase,
      });
      return undefined;
    }
    const lockedSettings: Required<RelativeScoringSettings> = {
      ...settings,
      challengeId,
      submissionApiUrl,
    };

    return this.withRelativeScoringLock(challengeId, testPhase, async () =>
      this.recomputeRelativeScoring(
        token,
        payload,
        testPhase,
        fallbackMetadata,
        fallbackScorecardId,
        lockedSettings,
      ),
    );
  }

  /**
   * Runs the relative scoring read-compute-write sequence after the caller has
   * acquired the challenge/phase lock.
   * @param token M2M token for submission-api and review-api requests.
   * @param payload Scorer callback payload for the completed submission.
   * @param testPhase Normalized scoring phase.
   * @param fallbackMetadata Metadata built from the callback body.
   * @param fallbackScorecardId Scorecard ID resolved from callback/config data.
   * @param settings Relative scoring configuration for the challenge.
   * @returns The current submission's recomputed aggregate score, or undefined
   * when relative scoring cannot be applied.
   * @throws Error when submission-api or review-api calls fail.
   */
  private async recomputeRelativeScoring(
    token: string,
    payload: ScoringResultCallbackPayload,
    testPhase: string,
    fallbackMetadata: Record<string, unknown>,
    fallbackScorecardId: string | undefined,
    settings: Required<RelativeScoringSettings>,
  ): Promise<number | undefined> {
    const submissions = await this.fetchChallengeSubmissions(
      token,
      settings.submissionApiUrl,
      settings.challengeId,
    );
    const currentSubmissionId = payload.submissionId.trim();
    const currentSubmission = submissions.find(
      (submission) =>
        this.extractSubmissionId(submission) === currentSubmissionId,
    );
    const currentMemberKey = currentSubmission
      ? this.extractSubmissionMemberKey(currentSubmission)
      : undefined;

    const currentReview = this.buildCurrentRelativeReviewRecord({
      payload,
      fallbackMetadata,
      fallbackScorecardId,
      existingReviewObject: this.findPhaseReviewSummation(
        currentSubmission,
        testPhase,
      ),
      memberKey: currentMemberKey,
      createdAt: this.resolveSubmissionDate(currentSubmission),
      testPhase,
    });

    if (!currentReview || currentReview.rawTestScores.length === 0) {
      this.logger.warn({
        message:
          'Relative scoring is enabled but current review metadata does not contain usable testScores. Falling back to direct review upsert.',
        submissionId: payload.submissionId,
        challengeId: settings.challengeId,
        testPhase,
      });
      return undefined;
    }

    const impactedReviews = this.selectLatestRelativeReviewRecords(
      submissions,
      testPhase,
      payload.reviewTypeId,
      payload.submissionId,
      currentMemberKey,
    );

    const reviewsToRecompute = [...impactedReviews, currentReview];
    const bestScores = this.computeBestScores(
      reviewsToRecompute,
      settings.scoreDirection,
    );

    const relativeReviewPayloads =
      this.sortRelativeReviewPayloadsForLeaderboard(
        reviewsToRecompute.map((reviewRecord, index) =>
          this.buildRelativeReviewPayload(
            reviewRecord,
            bestScores,
            settings.scoreDirection,
            fallbackScorecardId,
            testPhase,
            index < impactedReviews.length,
          ),
        ),
      );

    const currentReviewPayload = relativeReviewPayloads.find(
      (reviewPayload) =>
        reviewPayload.payload.submissionId === payload.submissionId,
    );

    if (!currentReviewPayload) {
      return undefined;
    }

    for (let index = 0; index < relativeReviewPayloads.length; index += 1) {
      const reviewPayload = relativeReviewPayloads[index];
      const reviewId = this.asString(reviewPayload.reviewObject.id);
      const isCurrentReview =
        reviewPayload.payload.submissionId === payload.submissionId;

      if (!reviewId && !isCurrentReview) {
        this.logger.warn({
          message:
            'Skipping impacted relative review update because reviewSummation id is missing.',
          submissionId: reviewPayload.payload.submissionId,
          testPhase,
        });
        continue;
      }

      await this.upsertReviewSummation(
        token,
        testPhase,
        reviewPayload.payload,
        reviewId,
      );
    }

    await this.completeSystemReviewIfNeeded(
      token,
      payload.reviewId,
      currentReviewPayload.payload.aggregateScore,
      testPhase,
      {
        challengeId: payload.challengeId,
        scorecardId: fallbackScorecardId,
        submissionId: payload.submissionId,
      },
    );

    return currentReviewPayload?.payload.aggregateScore;
  }

  /**
   * Serializes relative-score recomputation for one challenge and phase across
   * API instances sharing the same PostgreSQL database.
   * @param challengeId Challenge whose relative scores are being recomputed.
   * @param testPhase Normalized scoring phase.
   * @param work Async work to run while the transaction-scoped advisory lock is held.
   * @returns The value returned by the locked work.
   * @throws Error when the lock transaction or locked work fails.
   */
  private async withRelativeScoringLock<T>(
    challengeId: string,
    testPhase: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const { classId, objectId } = this.buildRelativeScoringLockIds(
      challengeId,
      testPhase,
    );

    return this.prisma.$transaction(async (prisma) => {
      await prisma.$executeRaw`
        SELECT pg_advisory_xact_lock(${classId}::integer, ${objectId}::integer)
      `;
      return work();
    });
  }

  /**
   * Builds deterministic PostgreSQL advisory lock identifiers for relative scoring.
   * @param challengeId Challenge whose score set should be locked.
   * @param testPhase Scoring phase included so provisional and system callbacks do not block each other.
   * @returns Two signed 32-bit integers accepted by `pg_advisory_xact_lock`.
   */
  private buildRelativeScoringLockIds(
    challengeId: string,
    testPhase: string,
  ): RelativeScoringLockIds {
    const digest = createHash('sha256')
      .update(
        `marathon-match-api-v6:relative-scoring:${challengeId}:${this.normalizeTestPhase(testPhase)}`,
      )
      .digest();

    return {
      classId: digest.readInt32BE(0),
      objectId: digest.readInt32BE(4),
    };
  }

  /**
   * Loads relative-scoring settings from config and callback metadata.
   */
  private resolveRelativeScoringSettings(
    payload: ScoringResultCallbackPayload,
    fallbackMetadata: Record<string, unknown>,
    config: ScoringResultConfigSummary,
  ): RelativeScoringSettings {
    const currentReview = this.asRecord(payload.currentReview);
    const currentMetadata = this.asRecord(currentReview.metadata);

    const relativeScoringEnabled =
      this.parseBooleanFlag(fallbackMetadata.relativeScoringEnabled) ??
      this.parseBooleanFlag(currentMetadata.relativeScoringEnabled) ??
      config.relativeScoringEnabled ??
      true;

    const scoreDirection =
      this.normalizeScoreDirection(
        this.asString(fallbackMetadata.scoreDirection),
      ) ??
      this.normalizeScoreDirection(
        this.asString(currentMetadata.scoreDirection),
      ) ??
      this.normalizeScoreDirectionFromBoolean(
        this.parseBooleanFlag(fallbackMetadata.isMaximize),
      ) ??
      this.normalizeScoreDirectionFromBoolean(
        this.parseBooleanFlag(currentMetadata.isMaximize),
      ) ??
      config.scoreDirection;

    return {
      challengeId: config.challengeId,
      submissionApiUrl: config.submissionApiUrl.trim() || undefined,
      enabled: relativeScoringEnabled === true,
      scoreDirection,
    };
  }

  /**
   * Loads the persisted Marathon Match config that owns an incoming scorer callback.
   */
  private async requireScoringResultConfig(
    challengeId: string,
  ): Promise<ScoringResultConfigSummary> {
    const normalizedChallengeId = this.asString(challengeId);
    const config = normalizedChallengeId
      ? await this.prisma.marathonMatchConfig.findUnique({
          where: { challengeId: normalizedChallengeId },
          select: {
            challengeId: true,
            name: true,
            submissionApiUrl: true,
            relativeScoringEnabled: true,
            scoreDirection: true,
          },
        })
      : null;

    if (!config) {
      throw new NotFoundException(
        `Marathon match config with challenge ID ${normalizedChallengeId ?? challengeId} not found.`,
      );
    }

    return config;
  }

  /**
   * Sends scoring completion emails once the relevant phase result set is complete.
   * Example/provisional emails are evaluated per callback submission; SYSTEM
   * emails are evaluated for all latest member submissions in the challenge.
   * @param token M2M token for downstream API calls.
   * @param payload Original scorer callback payload.
   * @param testPhase Normalized scoring phase from the callback.
   * @param config Marathon Match config summary for the callback challenge.
   * @returns Resolves after the notification check has completed.
   */
  private async notifyScoringCompletionEmailIfReady(
    token: string,
    payload: ScoringResultCallbackPayload,
    testPhase: string,
    config: ScoringResultConfigSummary,
  ): Promise<void> {
    if (!this.scoringCompletionEmailService) {
      return;
    }

    try {
      if (this.normalizeTestPhase(testPhase) === 'system') {
        const systemDetails = await this.resolveSystemScoringCompletionDetails(
          token,
          config,
        );
        if (systemDetails.length === 0) {
          return;
        }

        for (const details of systemDetails) {
          await this.scoringCompletionEmailService.sendSystemScoringCompleteEmail(
            token,
            details,
          );
        }
        return;
      }

      const completionDetails =
        await this.resolveSubmissionScoringCompletionDetails(
          token,
          config,
          payload.submissionId,
        );
      if (!completionDetails) {
        return;
      }

      await this.scoringCompletionEmailService.sendSubmissionScoringCompleteEmail(
        token,
        completionDetails,
      );
    } catch (error) {
      this.logger.error({
        message:
          'Unable to evaluate Marathon Match scoring completion email state.',
        challengeId: payload.challengeId,
        submissionId: payload.submissionId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Resolves member and final example/provisional score values from the latest
   * persisted submission data after review summation writes complete.
   * @param token M2M token for submission-api-v6.
   * @param config Marathon Match config summary for the challenge.
   * @param submissionId Submission identifier to inspect.
   * @returns Email details when both phases are complete, otherwise undefined.
   */
  private async resolveSubmissionScoringCompletionDetails(
    token: string,
    config: ScoringResultConfigSummary,
    submissionId: string,
  ): Promise<SubmissionScoringCompletionEmailDetails | undefined> {
    const submissions = await this.fetchChallengeSubmissions(
      token,
      config.submissionApiUrl,
      config.challengeId,
    );
    let submission = submissions.find(
      (entry) => this.extractSubmissionId(entry) === submissionId.trim(),
    );

    if (!submission) {
      submission = await this.fetchSubmissionById(
        token,
        config.submissionApiUrl,
        submissionId,
      );
      if (!submission) {
        this.logger.warn({
          message:
            'Skipping Marathon Match scoring completion email because submission-api-v6 did not return the callback submission.',
          challengeId: config.challengeId,
          submissionId,
        });
        return undefined;
      }
    }

    let memberIdentity = this.extractSubmissionMemberIdentity(submission);
    if (!this.hasSubmissionMemberIdentity(memberIdentity)) {
      const detailedSubmission = await this.fetchSubmissionById(
        token,
        config.submissionApiUrl,
        submissionId,
      );
      if (detailedSubmission) {
        submission = {
          ...submission,
          ...detailedSubmission,
        };
        memberIdentity = this.extractSubmissionMemberIdentity(submission);
      }
    }

    if (!this.hasSubmissionMemberIdentity(memberIdentity)) {
      this.logger.warn({
        message:
          'Skipping Marathon Match scoring completion email because the submission has no member handle or user ID.',
        challengeId: config.challengeId,
        submissionId,
      });
      return undefined;
    }

    const exampleResult = this.resolveCompletedPhaseScoringResult(
      this.findPhaseReviewSummation(submission, 'example'),
    );
    const provisionalResult = this.resolveCompletedPhaseScoringResult(
      this.findPhaseReviewSummation(submission, 'provisional'),
    );

    if (!exampleResult || !provisionalResult) {
      return undefined;
    }

    const challengeName = await this.resolveChallengeName(token, config);

    return {
      challengeId: config.challengeId,
      challengeName,
      submissionId,
      ...memberIdentity,
      scoringStatus:
        exampleResult.status === 'pass' && provisionalResult.status === 'pass'
          ? 'pass'
          : 'fail',
      aggregateProvisionalScore: provisionalResult.aggregateScore,
    };
  }

  /**
   * Resolves member placements and final SYSTEM score values from the latest
   * persisted submission data after all member SYSTEM review summation writes complete.
   * @param token M2M token for submission-api-v6.
   * @param config Marathon Match config summary for the challenge.
   * @returns Email details for all latest member submissions when SYSTEM scoring is complete, otherwise an empty array.
   */
  private async resolveSystemScoringCompletionDetails(
    token: string,
    config: ScoringResultConfigSummary,
  ): Promise<SystemScoringCompletionEmailDetails[]> {
    const submissions = await this.fetchChallengeSubmissions(
      token,
      config.submissionApiUrl,
      config.challengeId,
    );
    const latestSubmissions = this.selectLatestSubmissionsByMember(submissions);
    if (latestSubmissions.length === 0) {
      return [];
    }

    const completedCandidates: SystemScoringCompletionCandidate[] = [];
    for (const candidate of latestSubmissions) {
      let submission = candidate.submission;
      const submissionId = this.extractSubmissionId(submission);
      if (!submissionId) {
        this.logger.warn({
          message:
            'Skipping Marathon Match system scoring emails because a latest member submission has no submission ID.',
          challengeId: config.challengeId,
          memberKey: candidate.memberKey,
        });
        return [];
      }

      let memberIdentity = this.extractSubmissionMemberIdentity(submission);
      if (!this.hasSubmissionMemberIdentity(memberIdentity)) {
        const detailedSubmission = await this.fetchSubmissionById(
          token,
          config.submissionApiUrl,
          submissionId,
        );
        if (detailedSubmission) {
          submission = {
            ...submission,
            ...detailedSubmission,
          };
          memberIdentity = this.extractSubmissionMemberIdentity(submission);
        }
      }

      if (!this.hasSubmissionMemberIdentity(memberIdentity)) {
        this.logger.warn({
          message:
            'Skipping Marathon Match system scoring emails because a latest member submission has no member handle or user ID.',
          challengeId: config.challengeId,
          submissionId,
        });
        return [];
      }

      const systemResult = this.resolveCompletedPhaseScoringResult(
        this.findPhaseReviewSummation(submission, 'system'),
      );
      if (!systemResult) {
        return [];
      }

      completedCandidates.push({
        submissionId,
        ...memberIdentity,
        scoringResult: systemResult,
      });
    }

    const challengeName = await this.resolveChallengeName(token, config);

    return this.buildRankedSystemScoringCompletionDetails(
      completedCandidates,
      config,
      challengeName,
    );
  }

  /**
   * Selects one latest submission per member from submission-api-v6 results.
   * Prefers submissions explicitly marked `isLatest`, otherwise falls back to
   * the newest available submission timestamp for each member.
   * @param submissions Submission records returned by submission-api-v6.
   * @returns Latest submission candidates keyed by member.
   */
  private selectLatestSubmissionsByMember(
    submissions: Record<string, unknown>[],
  ): LatestMemberSubmissionCandidate[] {
    const latestByMember = new Map<string, LatestMemberSubmissionCandidate>();
    const flaggedLatestByMember = new Map<
      string,
      LatestMemberSubmissionCandidate
    >();

    submissions.forEach((submission, sequence) => {
      const submissionId = this.extractSubmissionId(submission);
      const memberKey = this.extractSubmissionMemberKey(submission);
      if (!submissionId || !memberKey) {
        return;
      }

      const candidate: LatestMemberSubmissionCandidate = {
        submission,
        memberKey,
        submittedDate: this.resolveSubmissionDate(submission),
        isLatest:
          this.parseBooleanFlag(submission.isLatest) ??
          this.parseBooleanFlag(submission.latest) ??
          undefined,
        sequence,
      };

      const currentLatest = latestByMember.get(memberKey);
      if (
        !currentLatest ||
        this.compareSubmissionCandidates(candidate, currentLatest) > 0
      ) {
        latestByMember.set(memberKey, candidate);
      }

      if (candidate.isLatest === true) {
        const currentFlaggedLatest = flaggedLatestByMember.get(memberKey);
        if (
          !currentFlaggedLatest ||
          this.compareSubmissionCandidates(candidate, currentFlaggedLatest) > 0
        ) {
          flaggedLatestByMember.set(memberKey, candidate);
        }
      }
    });

    return Array.from(latestByMember.entries()).map(
      ([memberKey, fallbackLatest]) =>
        flaggedLatestByMember.get(memberKey) ?? fallbackLatest,
    );
  }

  /**
   * Builds ranked SYSTEM email details after every latest member submission has
   * a completed SYSTEM result.
   * @param candidates Completed latest member submission score records.
   * @param config Marathon Match config summary for the challenge.
   * @returns Email details including ordinal placement strings.
   */
  private buildRankedSystemScoringCompletionDetails(
    candidates: SystemScoringCompletionCandidate[],
    config: ScoringResultConfigSummary,
    challengeName: string,
  ): SystemScoringCompletionEmailDetails[] {
    const rankedCandidates = [...candidates].sort((left, right) =>
      this.compareSystemScoringCandidates(left, right, config.scoreDirection),
    );

    let previousCandidate: SystemScoringCompletionCandidate | undefined;
    let previousRank = 0;

    return rankedCandidates.map((candidate, index) => {
      const rank =
        previousCandidate &&
        this.compareSystemScoringCandidates(
          candidate,
          previousCandidate,
          config.scoreDirection,
        ) === 0
          ? previousRank
          : index + 1;

      previousCandidate = candidate;
      previousRank = rank;

      return {
        challengeId: config.challengeId,
        challengeName,
        submissionId: candidate.submissionId,
        memberHandle: candidate.memberHandle,
        memberId: candidate.memberId,
        userId: candidate.userId,
        scoringStatus: candidate.scoringResult.status,
        finalSystemScore: candidate.scoringResult.aggregateScore,
        placement: this.formatOrdinalPlacement(rank),
      };
    });
  }

  /**
   * Compares two latest-submission candidates by submission timestamp and
   * response order.
   * @param left Candidate being evaluated.
   * @param right Current selected candidate.
   * @returns Positive when left is newer, negative when right is newer, zero when equal.
   */
  private compareSubmissionCandidates(
    left: LatestMemberSubmissionCandidate,
    right: LatestMemberSubmissionCandidate,
  ): number {
    const dateComparison = this.compareIsoDateStrings(
      left.submittedDate,
      right.submittedDate,
    );
    if (dateComparison !== 0) {
      return dateComparison;
    }

    return left.sequence - right.sequence;
  }

  /**
   * Compares completed SYSTEM scoring candidates for leaderboard placement.
   * Passing submissions rank ahead of failed submissions, then scores are
   * ordered using the challenge score direction.
   * @param left First completed scoring candidate.
   * @param right Second completed scoring candidate.
   * @param scoreDirection Challenge score direction.
   * @returns Negative when left ranks before right, positive when right ranks before left, zero for ties.
   */
  private compareSystemScoringCandidates(
    left: SystemScoringCompletionCandidate,
    right: SystemScoringCompletionCandidate,
    scoreDirection: ScoreDirection,
  ): number {
    if (left.scoringResult.status !== right.scoringResult.status) {
      return left.scoringResult.status === 'pass' ? -1 : 1;
    }

    const leftScore = left.scoringResult.aggregateScore;
    const rightScore = right.scoringResult.aggregateScore;
    if (leftScore === rightScore) {
      return 0;
    }

    return scoreDirection === ScoreDirection.MINIMIZE
      ? leftScore - rightScore
      : rightScore - leftScore;
  }

  /**
   * Formats a numeric rank into an ordinal placement string.
   * @param rank One-based placement rank.
   * @returns Ordinal placement string, such as `1st`, `2nd`, or `3rd`.
   */
  private formatOrdinalPlacement(rank: number): string {
    const remainder100 = rank % 100;
    if (remainder100 >= 11 && remainder100 <= 13) {
      return `${rank}th`;
    }

    switch (rank % 10) {
      case 1:
        return `${rank}st`;
      case 2:
        return `${rank}nd`;
      case 3:
        return `${rank}rd`;
      default:
        return `${rank}th`;
    }
  }

  /**
   * Extracts a submission identifier from current and legacy submission shapes.
   * @param submission Submission object returned by submission-api-v6.
   * @returns Submission identifier when present.
   */
  private extractSubmissionId(
    submission: Record<string, unknown>,
  ): string | undefined {
    return this.coalesceString(
      this.asString(submission.submissionId),
      this.asString(submission.id),
    );
  }

  /**
   * Extracts a stable member key used to reduce submissions to one latest
   * candidate per member.
   * @param submission Submission object returned by submission-api-v6.
   * @returns Member identifier or handle when present.
   */
  private extractSubmissionMemberKey(
    submission: Record<string, unknown>,
  ): string | undefined {
    const memberIdentity = this.extractSubmissionMemberIdentity(submission);

    return this.coalesceString(
      memberIdentity.userId,
      memberIdentity.memberId,
      memberIdentity.memberHandle,
    );
  }

  /**
   * Extracts member handle and ID values from known submission payload shapes.
   * @param submission Submission object returned by submission-api-v6.
   * @returns Available member identity values.
   */
  private extractSubmissionMemberIdentity(
    submission: Record<string, unknown>,
  ): SubmissionMemberIdentity {
    const member = this.asRecord(submission.member);
    const submitter = this.asRecord(submission.submitter);

    const userId = this.coalesceString(
      this.asString(submission.userId),
      this.asString(submission.memberId),
      this.asString(member.userId),
      this.asString(member.id),
      this.asString(submitter.userId),
      this.asString(submitter.id),
    );

    const memberIdentity: SubmissionMemberIdentity = {};
    const memberHandle = this.extractSubmissionMemberHandle(submission);
    const memberId = this.coalesceString(
      this.asString(submission.memberId),
      this.asString(member.id),
      this.asString(submitter.id),
    );

    if (memberHandle) {
      memberIdentity.memberHandle = memberHandle;
    }
    if (memberId) {
      memberIdentity.memberId = memberId;
    }
    if (userId) {
      memberIdentity.userId = userId;
    }

    return memberIdentity;
  }

  /**
   * Checks whether a submission carries enough member identity to resolve an email.
   * @param memberIdentity Member identity extracted from a submission.
   * @returns True when a handle, member ID, or user ID is available.
   */
  private hasSubmissionMemberIdentity(
    memberIdentity: SubmissionMemberIdentity,
  ): boolean {
    return Boolean(
      memberIdentity.memberHandle ||
      memberIdentity.userId ||
      memberIdentity.memberId,
    );
  }

  /**
   * Extracts a completed aggregate score and pass/fail status from a phase
   * review summation.
   * @param reviewObject Review summation object returned by submission-api-v6.
   * @returns Phase scoring result when scoring is complete, otherwise undefined.
   */
  private resolveCompletedPhaseScoringResult(
    reviewObject: Record<string, unknown> | null,
  ): CompletedPhaseScoringResult | undefined {
    if (!reviewObject) {
      return undefined;
    }

    const metadata = this.asRecord(reviewObject.metadata);
    const aggregateScore =
      this.toNumber(reviewObject.aggregateScore) ??
      this.toNumber(reviewObject.score);
    if (aggregateScore === null) {
      return undefined;
    }

    const testStatus = this.asString(metadata.testStatus)?.toUpperCase();
    if (testStatus === ScoringTestStatus.InProgress) {
      return undefined;
    }

    const testProgress = this.toNumber(metadata.testProgress);
    if (testProgress !== null && testProgress < 1) {
      return undefined;
    }

    const isPassing = this.parseBooleanFlag(reviewObject.isPassing);
    const status =
      testStatus === ScoringTestStatus.Failed ||
      isPassing === false ||
      aggregateScore < 0
        ? 'fail'
        : 'pass';

    return {
      aggregateScore,
      status,
    };
  }

  /**
   * Extracts the competitor handle from known submission payload shapes.
   * @param submission Submission object returned by submission-api-v6.
   * @returns Member handle when present.
   */
  private extractSubmissionMemberHandle(
    submission: Record<string, unknown>,
  ): string | undefined {
    const member = this.asRecord(submission.member);
    const submitter = this.asRecord(submission.submitter);

    return this.coalesceString(
      this.asString(submission.memberHandle),
      this.asString(submission.handle),
      this.asString(member.handle),
      this.asString(submitter.handle),
    );
  }

  /**
   * Fetches all submissions for one challenge through the submission API.
   */
  private async fetchChallengeSubmissions(
    token: string,
    submissionApiUrl: string,
    challengeId: string,
  ): Promise<Record<string, unknown>[]> {
    const submissions: Record<string, unknown>[] = [];
    let page = 1;
    let totalPages = 1;

    do {
      const url = `${this.buildSubmissionApiBaseUrl(
        submissionApiUrl,
      )}/submissions`;
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            challengeId,
            perPage: 100,
            page,
          },
        }),
      );

      submissions.push(...this.extractSubmissionArray(response.data));
      totalPages = this.parseTotalPages(response.headers);
      page += 1;
    } while (page <= totalPages);

    return submissions;
  }

  /**
   * Fetches one submission by ID from submission-api-v6 for identity fallback.
   * @param token M2M token for submission-api-v6.
   * @param submissionApiUrl Configured submission-api-v6 base URL.
   * @param submissionId Submission identifier to fetch.
   * @returns Submission record when the API returns one, otherwise undefined.
   */
  private async fetchSubmissionById(
    token: string,
    submissionApiUrl: string,
    submissionId: string,
  ): Promise<Record<string, unknown> | undefined> {
    const url = `${this.buildSubmissionApiBaseUrl(
      submissionApiUrl,
    )}/submissions/${encodeURIComponent(submissionId)}`;
    const response = await firstValueFrom(
      this.httpService.get(url, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    return this.extractSubmissionRecord(response.data);
  }

  /**
   * Checks whether a submission-api record is eligible for scorer execution.
   * @param submission Submission record returned by submission-api-v6.
   * @returns True only when `virusScan` is explicitly true.
   */
  private isSubmissionCleanForScoring(
    submission: Record<string, unknown> | undefined,
  ): boolean {
    return this.parseBooleanFlag(submission?.virusScan) === true;
  }

  /**
   * Resolves the public challenge name from challenge-api-v6 for email payloads.
   * Falls back to the stored Marathon Match config name when challenge-api does
   * not return a usable name.
   * @param token M2M token for challenge-api-v6.
   * @param config Marathon Match config summary for the challenge.
   * @returns Challenge title to include in email template data.
   */
  private async resolveChallengeName(
    token: string,
    config: ScoringResultConfigSummary,
  ): Promise<string> {
    const cached = this.challengeNameLookupCache.get(config.challengeId);
    if (cached !== undefined) {
      return cached;
    }

    const url = `${this.challengeApiBaseUrl}/v6/challenges/${encodeURIComponent(config.challengeId)}`;
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
      const challengeName = this.extractChallengeName(response.data);
      if (challengeName) {
        this.challengeNameLookupCache.set(config.challengeId, challengeName);
      }
      return challengeName ?? config.name;
    } catch (error) {
      this.logger.warn({
        message:
          'Unable to resolve challenge name from challenge-api. Falling back to Marathon Match config name.',
        challengeId: config.challengeId,
        url,
        error: error instanceof Error ? error.message : String(error),
      });
      return config.name;
    }
  }

  /**
   * Selects the latest scored submission per member for the requested phase.
   * Member keys are resolved from all supported submission identity fields so
   * legacy payloads without top-level `memberId` still collapse to one record.
   * @param submissions Submission records returned by submission-api-v6.
   * @param testPhase Requested scoring phase.
   * @param reviewTypeId Review type identifier to preserve in normalized metadata.
   * @param excludedSubmissionId Current callback submission ID to skip.
   * @param excludedMemberKey Current callback member key to skip when present.
   * @returns Recomputable latest scored review records for other members.
   */
  private selectLatestRelativeReviewRecords(
    submissions: Record<string, unknown>[],
    testPhase: string,
    reviewTypeId: string,
    excludedSubmissionId: string,
    excludedMemberKey?: string,
  ): RelativeReviewRecord[] {
    const latestByMember = new Map<string, LatestRelativeReviewCandidate>();
    const normalizedExcludedSubmissionId = excludedSubmissionId.trim();

    for (const [sequence, submission] of submissions.entries()) {
      const submissionId = this.extractSubmissionId(submission);
      if (!submissionId || submissionId === normalizedExcludedSubmissionId) {
        continue;
      }

      const rawMemberKey = this.extractSubmissionMemberKey(submission);
      const memberKey = rawMemberKey ?? `submission:${submissionId}`;
      if (excludedMemberKey && rawMemberKey === excludedMemberKey) {
        continue;
      }

      const reviewObject = this.findPhaseReviewSummation(submission, testPhase);
      if (!reviewObject) {
        continue;
      }

      const memberIdentity = this.extractSubmissionMemberIdentity(submission);
      const candidate: LatestRelativeReviewCandidate = {
        submission,
        submissionId,
        memberKey,
        memberId: memberIdentity.memberId,
        submittedDate: this.resolveSubmissionDate(submission),
        isLatest:
          this.parseBooleanFlag(submission.isLatest) ??
          this.parseBooleanFlag(submission.latest) ??
          undefined,
        sequence,
        reviewObject,
      };
      const existing = latestByMember.get(memberKey);

      if (
        !existing ||
        this.compareRelativeReviewCandidates(candidate, existing) > 0
      ) {
        latestByMember.set(memberKey, candidate);
      }
    }

    return Array.from(latestByMember.values())
      .map((candidate) =>
        this.buildRelativeReviewRecord({
          createdAt: candidate.submittedDate,
          memberKey: candidate.memberKey,
          reviewObject: candidate.reviewObject,
          reviewTypeId,
          submissionId: candidate.submissionId,
          testPhase,
        }),
      )
      .filter((entry): entry is RelativeReviewRecord => entry !== null);
  }

  /**
   * Compares scored relative-review candidates for per-member latest selection.
   * `isLatest=true` is authoritative when present; otherwise timestamp and
   * response order decide the winner.
   * @param left Candidate being evaluated.
   * @param right Current selected candidate.
   * @returns Positive when left should replace right, negative when right wins.
   */
  private compareRelativeReviewCandidates(
    left: LatestRelativeReviewCandidate,
    right: LatestRelativeReviewCandidate,
  ): number {
    const leftIsLatest = left.isLatest === true;
    const rightIsLatest = right.isLatest === true;
    if (leftIsLatest !== rightIsLatest) {
      return leftIsLatest ? 1 : -1;
    }

    return this.compareSubmissionCandidates(left, right);
  }

  /**
   * Builds the current submission review object used for relative scoring.
   */
  private buildCurrentRelativeReviewRecord(args: {
    payload: ScoringResultCallbackPayload;
    fallbackMetadata: Record<string, unknown>;
    fallbackScorecardId?: string;
    existingReviewObject: Record<string, unknown> | null;
    memberKey?: string;
    createdAt?: string;
    testPhase: string;
  }): RelativeReviewRecord | null {
    const currentReviewObject = this.asRecord(args.payload.currentReview);
    const existingReviewObject = this.asRecord(args.existingReviewObject);
    const metadata = this.normalizeMetadata(
      this.asRecord(currentReviewObject.metadata),
      args.testPhase,
      args.payload.reviewTypeId,
      args.fallbackMetadata,
    );

    const mergedReviewObject: Record<string, unknown> = {
      ...existingReviewObject,
      ...currentReviewObject,
      submissionId: args.payload.submissionId,
      metadata,
    };

    if (
      args.fallbackScorecardId &&
      !this.asString(mergedReviewObject.scorecardId) &&
      !this.asString(mergedReviewObject.scoreCardId)
    ) {
      mergedReviewObject.scorecardId = args.fallbackScorecardId;
    }

    if (this.toNumber(mergedReviewObject.score) === null) {
      mergedReviewObject.score = args.payload.score;
    }
    if (this.toNumber(mergedReviewObject.aggregateScore) === null) {
      mergedReviewObject.aggregateScore = args.payload.score;
    }

    return this.buildRelativeReviewRecord({
      createdAt: args.createdAt,
      memberKey: args.memberKey,
      reviewObject: mergedReviewObject,
      reviewTypeId: args.payload.reviewTypeId,
      submissionId: args.payload.submissionId,
      testPhase: args.testPhase,
    });
  }

  /**
   * Normalizes one review object into a recomputable relative-score record.
   */
  private buildRelativeReviewRecord(args: {
    createdAt?: string;
    memberKey?: string;
    reviewObject: Record<string, unknown>;
    reviewTypeId: string;
    submissionId: string;
    testPhase: string;
  }): RelativeReviewRecord | null {
    const reviewObject = this.asRecord(args.reviewObject);
    const metadata = this.normalizeMetadata(
      this.asRecord(reviewObject.metadata),
      args.testPhase,
      args.reviewTypeId,
    );
    const rawTestScores = this.extractRawTestScores(metadata);

    if (rawTestScores.length === 0) {
      return null;
    }

    return {
      submissionId: args.submissionId,
      memberKey: args.memberKey,
      createdAt: args.createdAt,
      reviewObject: {
        ...reviewObject,
        submissionId: args.submissionId,
        metadata,
      },
      metadata,
      rawTestScores,
    };
  }

  /**
   * Calculates the best raw testcase score currently achieved for each seed.
   * Error scores, negative sentinel scores, and MINIMIZE zero scores are excluded
   * so invalid/no-credit results cannot become normalization baselines.
   */
  private computeBestScores(
    reviewRecords: RelativeReviewRecord[],
    scoreDirection: ScoreDirection,
  ): Map<string, number> {
    const bestScores = new Map<string, number>();

    for (const reviewRecord of reviewRecords) {
      for (const testScore of reviewRecord.rawTestScores) {
        if (
          testScore.score < 0 ||
          testScore.error ||
          (scoreDirection === ScoreDirection.MINIMIZE && testScore.score === 0)
        ) {
          continue;
        }

        const existing = bestScores.get(testScore.testcase);
        if (existing === undefined) {
          bestScores.set(testScore.testcase, testScore.score);
          continue;
        }

        if (
          (scoreDirection === ScoreDirection.MAXIMIZE &&
            testScore.score > existing) ||
          (scoreDirection === ScoreDirection.MINIMIZE &&
            testScore.score < existing)
        ) {
          bestScores.set(testScore.testcase, testScore.score);
        }
      }
    }

    return bestScores;
  }

  /**
   * Builds one updated review summation payload with normalized relative scores.
   */
  private buildRelativeReviewPayload(
    reviewRecord: RelativeReviewRecord,
    bestScores: Map<string, number>,
    scoreDirection: ScoreDirection,
    fallbackScorecardId: string | undefined,
    testPhase: string,
    preserveReviewedDate = false,
  ): RelativeReviewPayload {
    let totalTests = 0;
    let failedTests = 0;
    let aggregateScore = 0;
    const relativeScores: Array<Record<string, unknown>> = [];

    for (const rawTestScore of reviewRecord.rawTestScores) {
      totalTests += 1;

      const bestScore = bestScores.get(rawTestScore.testcase);
      const relativeScore = this.calculateRelativeScore(
        rawTestScore.score,
        bestScore,
        scoreDirection,
      );

      if (rawTestScore.score < 0 || rawTestScore.error) {
        failedTests += 1;
      }

      aggregateScore += relativeScore;
      relativeScores.push({
        testcase: rawTestScore.testcase,
        score: relativeScore,
      });
    }

    if (totalTests > 0) {
      aggregateScore /= totalTests;
    } else {
      aggregateScore = -1;
    }

    if (failedTests === totalTests) {
      aggregateScore = -1;
    }

    const metadata = this.withTestProgressMetadata(
      {
        ...reviewRecord.metadata,
        relativeScoringEnabled: true,
        scoreDirection,
        relativeScores,
        tests: {
          total: totalTests,
          passed: totalTests - failedTests,
          failed: failedTests,
        },
      },
      {
        completedTests: totalTests,
        failedTests,
        progress: 1,
        status:
          totalTests > 0 ? ScoringTestStatus.Success : ScoringTestStatus.Failed,
        totalTests,
      },
    );

    const reviewObject: Record<string, unknown> = {
      ...reviewRecord.reviewObject,
      metadata,
      submissionId: reviewRecord.submissionId,
      score: aggregateScore,
      aggregateScore,
    };

    const scorecardId = this.coalesceString(
      this.asString(reviewObject.scorecardId),
      this.asString(reviewObject.scoreCardId),
      fallbackScorecardId,
    );

    return {
      reviewObject,
      payload: this.buildSummationPayload({
        submissionId: reviewRecord.submissionId,
        score: aggregateScore,
        scorecardId,
        metadata,
        preserveReviewedDate,
        reviewObject,
        testPhase,
      }),
    };
  }

  /**
   * Orders recomputed relative review summation writes to match leaderboard order.
   * Review API assigns provisional/final rank values from the persisted update
   * sequence, so passing higher aggregate scores must be written before lower
   * or failed results.
   * @param reviewPayloads Recomputed relative review summation payloads.
   * @returns A new payload list sorted by leaderboard position.
   */
  private sortRelativeReviewPayloadsForLeaderboard(
    reviewPayloads: RelativeReviewPayload[],
  ): RelativeReviewPayload[] {
    return [...reviewPayloads].sort((left, right) => {
      if (left.payload.isPassing !== right.payload.isPassing) {
        return left.payload.isPassing ? -1 : 1;
      }

      return right.payload.aggregateScore - left.payload.aggregateScore;
    });
  }

  /**
   * Converts one raw testcase score into its 0..100 relative score.
   * Zero best scores are guarded explicitly to avoid NaN/Infinity.
   */
  private calculateRelativeScore(
    rawScore: number,
    bestScore: number | undefined,
    scoreDirection: ScoreDirection,
  ): number {
    if (rawScore < 0 || bestScore === undefined) {
      return 0;
    }

    if (bestScore === 0) {
      return rawScore === 0 && scoreDirection === ScoreDirection.MINIMIZE
        ? 100
        : 0;
    }

    if (rawScore === 0) {
      return 0;
    }

    if (Math.abs(bestScore - rawScore) < 1e-9) {
      return 100;
    }

    const normalized =
      bestScore < rawScore ? bestScore / rawScore : rawScore / bestScore;
    return normalized * 100;
  }

  /**
   * Extracts raw tester testScores metadata into normalized seed/score pairs.
   */
  private extractRawTestScores(
    metadata: Record<string, unknown>,
  ): RelativeTestScoreEntry[] {
    const rawEntries = metadata.testScores;
    if (!Array.isArray(rawEntries)) {
      return [];
    }

    const result: RelativeTestScoreEntry[] = [];
    for (const rawEntry of rawEntries) {
      const entry = this.asRecord(rawEntry);
      const testcase = this.asString(entry.testcase);
      const score = this.toNumber(entry.score);
      const error = this.asString(entry.error);
      const hasScore = Object.prototype.hasOwnProperty.call(entry, 'score');

      if (!testcase || (!hasScore && score === null)) {
        continue;
      }

      if (score === null || score > MAX_REVIEW_SCORE) {
        result.push({
          testcase,
          score: -1,
          error:
            error ??
            `Invalid score value suppressed; scores must be finite and no greater than ${MAX_REVIEW_SCORE_LABEL}.`,
        });
        continue;
      }

      result.push({
        testcase,
        score,
        error,
      });
    }

    return result;
  }

  /**
   * Finds the review summation that belongs to the requested scoring phase.
   */
  private findPhaseReviewSummation(
    submission: Record<string, unknown> | undefined,
    testPhase: string,
  ): Record<string, unknown> | null {
    if (!submission) {
      return null;
    }

    for (const review of this.extractReviewSummations(submission)) {
      if (this.matchesPhaseReview(review, testPhase)) {
        return review;
      }
    }

    return null;
  }

  /**
   * Extracts reviewSummation arrays from submission payloads with legacy key support.
   */
  private extractReviewSummations(
    submission: Record<string, unknown>,
  ): Record<string, unknown>[] {
    const reviewSummation = submission.reviewSummation;
    if (Array.isArray(reviewSummation)) {
      return reviewSummation.map((entry) => this.asRecord(entry));
    }

    const reviewSummations = submission.reviewSummations;
    if (Array.isArray(reviewSummations)) {
      return reviewSummations.map((entry) => this.asRecord(entry));
    }

    return [];
  }

  /**
   * Matches one review summation to example, provisional, or system scoring.
   */
  private matchesPhaseReview(
    reviewObject: Record<string, unknown>,
    testPhase: string,
  ): boolean {
    const metadata = this.asRecord(reviewObject.metadata);
    const metadataTestType = this.normalizeTestPhase(
      this.asString(metadata.testType),
    );
    const metadataStage = this.asString(metadata.stage)?.toLowerCase();

    if (testPhase === 'example') {
      return (
        this.parseBooleanFlag(reviewObject.isExample) === true ||
        metadataTestType === 'example'
      );
    }

    if (testPhase === 'system') {
      return (
        this.parseBooleanFlag(reviewObject.isFinal) === true ||
        metadataTestType === 'system' ||
        metadataStage === 'final'
      );
    }

    return (
      this.parseBooleanFlag(reviewObject.isProvisional) === true ||
      metadataTestType === 'provisional'
    );
  }

  /**
   * Builds the payload sent to review-api reviewSummations endpoints.
   */
  private buildSummationPayload(
    input: SummationBuildInput,
  ): ReviewSummationPayload {
    this.validateReviewScore(input.score, 'Review summation score');

    const metadata = this.asRecord(input.metadata);
    const existingReviewedDate = input.preserveReviewedDate
      ? this.asString(input.reviewObject?.reviewedDate)
      : undefined;

    const normalizedTestType = this.normalizeTestPhase(
      this.coalesceString(this.asString(metadata.testType), input.testPhase),
    );
    const normalizedStage = this.asString(metadata.stage)?.toLowerCase();

    const metaIsFinal = this.parseBooleanFlag(metadata.isFinal);
    const reviewIsFinal = this.parseBooleanFlag(input.reviewObject?.isFinal);
    const metaIsProvisional = this.parseBooleanFlag(metadata.isProvisional);
    const metaIsExample = this.parseBooleanFlag(metadata.isExample);
    const testStatus = this.asString(metadata.testStatus);

    const shouldSetFinal =
      metaIsFinal === true ||
      reviewIsFinal === true ||
      normalizedTestType === 'system' ||
      normalizedStage === 'final';

    const shouldSetProvisional =
      !shouldSetFinal &&
      (normalizedTestType === 'provisional' || metaIsProvisional === true);

    const shouldSetExample =
      normalizedTestType === 'example' || metaIsExample === true;

    return {
      submissionId: input.submissionId,
      aggregateScore: input.score,
      isPassing:
        input.score >= 0 &&
        testStatus !== ScoringTestStatus.InProgress &&
        testStatus !== ScoringTestStatus.Failed,
      reviewedDate: existingReviewedDate ?? new Date().toISOString(),
      ...(input.scorecardId ? { scorecardId: input.scorecardId } : {}),
      ...(shouldSetFinal ? { isFinal: true } : {}),
      ...(shouldSetProvisional ? { isProvisional: true } : {}),
      ...(shouldSetExample ? { isExample: true } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };
  }

  /**
   * Applies one legacy-style review object as either a create or update request.
   */
  private async upsertFromLegacyReviewPayload(
    token: string,
    args: {
      legacyReview: Record<string, unknown>;
      fallbackSubmissionId: string;
      fallbackScore: number;
      fallbackScorecardId?: string;
      fallbackMetadata: Record<string, unknown>;
      testPhase: string;
    },
  ): Promise<number> {
    const reviewObject = this.asRecord(args.legacyReview);

    const submissionId = this.coalesceString(
      this.asString(reviewObject.submissionId),
      args.fallbackSubmissionId,
    );

    if (!submissionId) {
      throw new Error('Legacy review payload is missing submissionId.');
    }

    const rawScorecardId = this.coalesceString(
      this.asString(reviewObject.scorecardId),
      this.asString(reviewObject.scoreCardId),
      args.fallbackScorecardId,
    );
    const scorecardId = await this.resolveScorecardId(token, rawScorecardId);

    const score = this.resolveReviewScore(
      reviewObject,
      args.testPhase,
      args.fallbackScore,
    );
    const metadata = this.withFinalTestProgressMetadata(
      this.normalizeMetadata(
        this.asRecord(reviewObject.metadata),
        args.testPhase,
        this.asString(args.fallbackMetadata.reviewTypeId),
        args.fallbackMetadata,
      ),
      score,
    );

    const reviewPayload = this.buildSummationPayload({
      submissionId,
      score,
      scorecardId,
      metadata,
      reviewObject,
      testPhase: args.testPhase,
    });

    const reviewId = this.asString(reviewObject.id);
    if (reviewId) {
      await this.updateReviewSummation(token, reviewId, reviewPayload);
      return reviewPayload.aggregateScore;
    }

    await this.upsertReviewSummation(token, args.testPhase, reviewPayload);
    return reviewPayload.aggregateScore;
  }

  /**
   * Resolves the numeric score stored in a legacy review payload.
   */
  private resolveReviewScore(
    reviewObject: Record<string, unknown>,
    testPhase: string,
    fallbackScore: number,
  ): number {
    const systemPhase = this.normalizeTestPhase(testPhase) === 'system';

    const preferredScore = this.toNumber(
      reviewObject[systemPhase ? 'aggregateScore' : 'score'],
    );
    if (preferredScore !== null) {
      return preferredScore;
    }

    const alternateScore = this.toNumber(
      reviewObject[systemPhase ? 'score' : 'aggregateScore'],
    );
    if (alternateScore !== null) {
      return alternateScore;
    }

    return fallbackScore;
  }

  /**
   * Ensures metadata carries the active test type/process and optional review type.
   */
  private normalizeMetadata(
    metadata: Record<string, unknown> | undefined,
    testPhase: string,
    reviewTypeId?: string,
    fallbackMetadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalizedTestPhase = this.normalizeTestPhase(testPhase);
    const normalized: Record<string, unknown> = {
      ...(fallbackMetadata ?? {}),
      ...(metadata ?? {}),
      testType: normalizedTestPhase,
    };
    if (
      normalizedTestPhase === 'provisional' ||
      normalizedTestPhase === 'system'
    ) {
      normalized.testProcess = normalizedTestPhase;
    } else {
      delete normalized.testProcess;
    }

    if (reviewTypeId) {
      normalized.reviewTypeId = reviewTypeId;
    }

    return this.sanitizeMemberVisibleMetadata(normalized);
  }

  /**
   * Removes configured seed values from metadata persisted to review-api.
   * Per-test score arrays keep stable 1-based test ordinals for relative scoring.
   */
  private sanitizeMemberVisibleMetadata(
    metadata: Record<string, unknown>,
  ): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(metadata)) {
      if (this.isSensitiveSeedMetadataKey(key)) {
        continue;
      }

      if (
        (key === 'testScores' || key === 'relativeScores') &&
        Array.isArray(value)
      ) {
        sanitized[key] = this.sanitizeScoreEntries(value);
        continue;
      }

      if (key === 'message' && typeof value === 'string') {
        sanitized[key] = this.sanitizeProgressMessage(value);
        continue;
      }

      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sanitized[key] = this.sanitizeMemberVisibleMetadata(
          this.asRecord(value),
        );
        continue;
      }

      sanitized[key] = value;
    }

    return sanitized;
  }

  /**
   * Replaces raw seed-valued test identifiers with 1-based ordinals.
   */
  private sanitizeScoreEntries(entries: unknown[]): Record<string, unknown>[] {
    return entries.map((rawEntry, index) => {
      const entry = this.asRecord(rawEntry);
      const sanitizedEntry: Record<string, unknown> = {};

      for (const [key, value] of Object.entries(entry)) {
        if (key === 'testcase' || this.isSensitiveSeedMetadataKey(key)) {
          continue;
        }
        sanitizedEntry[key] = value;
      }

      const score = this.toNumber(entry.score);
      if (
        Object.prototype.hasOwnProperty.call(entry, 'score') &&
        (score === null || score > MAX_REVIEW_SCORE)
      ) {
        sanitizedEntry.score = -1;
        sanitizedEntry.error = this.coalesceString(
          this.asString(sanitizedEntry.error),
          `Invalid score value suppressed; scores must be finite and no greater than ${MAX_REVIEW_SCORE_LABEL}.`,
        );
      }

      sanitizedEntry.testcase = String(index + 1);
      return sanitizedEntry;
    });
  }

  /**
   * Detects metadata keys that directly carry configured seed values.
   */
  private isSensitiveSeedMetadataKey(key: string): boolean {
    const normalized = key.replace(/[_-]/g, '').toLowerCase();
    return (
      normalized === 'seed' ||
      normalized === 'seeds' ||
      normalized === 'startseed' ||
      normalized === 'endseed' ||
      normalized === 'phasestartseed' ||
      normalized === 'phaseendseed'
    );
  }

  /**
   * Removes seed values from progress messages before they are stored.
   */
  private sanitizeProgressMessage(
    message: string | undefined,
    completedTests?: number,
    totalTests?: number,
  ): string | undefined {
    if (!message) {
      return undefined;
    }

    if (!/\b(?:seed|startSeed|endSeed|phaseStartSeed)\b/i.test(message)) {
      return message;
    }

    if (completedTests !== undefined && totalTests !== undefined) {
      return `Completed test ${completedTests} of ${totalTests}`;
    }
    if (completedTests !== undefined) {
      return `Completed test ${completedTests}`;
    }
    return 'Test progress updated';
  }

  /**
   * Adds final progress/status fields to scorer metadata after tests finish.
   * @param metadata Review summation metadata built from runner callback data.
   * @param finalScore Aggregate score returned by the runner.
   * @returns Metadata with `testProgress` and `testStatus` populated.
   */
  private withFinalTestProgressMetadata(
    metadata: Record<string, unknown>,
    finalScore: number,
  ): Record<string, unknown> {
    const totalTests = this.resolveTotalTests(metadata);
    const completedTestScores = this.countCompletedTestScores(metadata);
    const completedTests = totalTests ?? completedTestScores;
    const failedTests = this.countFailedTestScores(metadata);
    const status =
      finalScore < 0 && completedTestScores === 0
        ? ScoringTestStatus.Failed
        : ScoringTestStatus.Success;

    return this.withTestProgressMetadata(metadata, {
      completedTests,
      failedTests,
      progress: 1,
      status,
      totalTests: totalTests ?? completedTests,
    });
  }

  /**
   * Adds normalized progress fields to review summation metadata.
   * @param metadata Existing metadata to preserve.
   * @param progress Progress details supplied by the runner or final callback.
   * @returns Metadata with a numeric progress value, status flag, and detail object.
   */
  private withTestProgressMetadata(
    metadata: Record<string, unknown>,
    progress: {
      progress: number;
      status: ScoringTestStatus;
      completedTests?: number;
      totalTests?: number;
      failedTests?: number;
      message?: string;
      reviewId?: string;
    },
  ): Record<string, unknown> {
    const normalizedProgress = this.clampProgress(progress.progress);
    const completedTests = this.normalizeNonNegativeInteger(
      progress.completedTests,
    );
    const totalTests = this.normalizeNonNegativeInteger(progress.totalTests);
    const failedTests = this.normalizeNonNegativeInteger(progress.failedTests);
    const message = this.sanitizeProgressMessage(
      this.asString(progress.message),
      completedTests,
      totalTests,
    );
    const reviewId = this.asString(progress.reviewId);
    const testProcess = this.asString(metadata.testProcess);
    const details: Record<string, unknown> = {
      progress: normalizedProgress,
      status: progress.status,
      updatedAt: new Date().toISOString(),
    };

    if (completedTests !== undefined) {
      details.completedTests = completedTests;
    }
    if (totalTests !== undefined) {
      details.totalTests = totalTests;
    }
    if (failedTests !== undefined) {
      details.failedTests = failedTests;
    }
    if (message) {
      details.message = message;
    }
    if (reviewId) {
      details.reviewId = reviewId;
    }
    if (testProcess) {
      details.testProcess = testProcess;
    }

    return {
      ...metadata,
      testProgress: normalizedProgress,
      testStatus: progress.status,
      testProgressDetails: details,
    };
  }

  /**
   * Chooses a neutral placeholder score for active progress updates.
   * @param status Runner progress status being persisted.
   * @returns `-1` only for explicit failed progress; otherwise `0` until the final callback writes the real score.
   */
  private progressPlaceholderScore(status: ScoringTestStatus): number {
    return status === ScoringTestStatus.Failed ? -1 : 0;
  }

  /**
   * Creates a phase review summation or updates every matching existing row.
   * @param token M2M token for review-api.
   * @param testPhase Normalized or raw phase value.
   * @param payload Review summation payload to persist.
   * @param preferredReviewSummationId Optional known row ID to update alongside
   * any phase matches returned by review-api.
   */
  private async upsertReviewSummation(
    token: string,
    testPhase: string,
    payload: ReviewSummationPayload,
    preferredReviewSummationId?: string,
  ): Promise<void> {
    const existingReviews = await this.findExistingReviewSummations(
      token,
      payload.submissionId,
      testPhase,
    );
    const reviewSummationIds = new Set<string>();
    const normalizedPreferredReviewSummationId = this.asString(
      preferredReviewSummationId,
    );

    if (normalizedPreferredReviewSummationId) {
      reviewSummationIds.add(normalizedPreferredReviewSummationId);
    }

    for (const existingReview of existingReviews) {
      const reviewSummationId = this.asString(existingReview.id);
      if (reviewSummationId) {
        reviewSummationIds.add(reviewSummationId);
      }
    }

    if (reviewSummationIds.size > 0) {
      for (const reviewSummationId of reviewSummationIds) {
        await this.updateReviewSummation(token, reviewSummationId, payload);
      }
      return;
    }

    await this.createReviewSummation(token, payload);
  }

  /**
   * Looks up existing review summations for one submission and scoring phase.
   * Duplicate phase summations can happen when review-api creates a SYSTEM
   * summation near the same time runner progress creates its placeholder.
   * Returning every matching row lets final callbacks keep stale progress rows
   * in sync with the completed score/status.
   * @param token M2M token for review-api.
   * @param submissionId Submission ID.
   * @param testPhase Example, provisional, or system scoring phase.
   * @returns Matching review summation records, or the API-filtered fallback row.
   */
  private async findExistingReviewSummations(
    token: string,
    submissionId: string,
    testPhase: string,
  ): Promise<Record<string, unknown>[]> {
    const params: Record<string, string> = {
      metadata: 'true',
      submissionId,
    };
    const normalizedPhase = this.normalizeTestPhase(testPhase);

    if (normalizedPhase === 'example') {
      params.example = 'true';
    } else if (normalizedPhase === 'system') {
      params.system = 'true';
    } else {
      params.provisional = 'true';
    }

    const response = await firstValueFrom(
      this.httpService.get(this.buildReviewSummationUrl(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params,
      }),
    );
    const reviewSummations = this.extractReviewSummationArray(response.data);
    const matchingReviews = reviewSummations.filter((review) =>
      this.matchesPhaseReview(review, normalizedPhase),
    );

    if (matchingReviews.length > 0) {
      return matchingReviews;
    }

    return reviewSummations[0] ? [reviewSummations[0]] : [];
  }

  /**
   * Sends a create request to review-api.
   * @throws BadRequestException When review-api rejects the payload as invalid, including unknown submission references.
   */
  private async createReviewSummation(
    token: string,
    payload: ReviewSummationPayload,
  ): Promise<void> {
    const url = this.buildReviewSummationUrl();

    try {
      await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
    } catch (error) {
      const errorDetails = this.extractHttpError(error);
      this.logger.error({
        message: 'Failed to create review summation',
        url,
        payload,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      if (errorDetails.statusCode === 400 || errorDetails.statusCode === 404) {
        throw new BadRequestException(
          `Failed to create review summation: ${errorDetails.message}`,
        );
      }
      throw new Error(
        `Failed to create review summation: ${errorDetails.message}`,
      );
    }
  }

  /**
   * Sends an update request to review-api.
   * @throws BadRequestException When review-api rejects the payload as invalid, including unknown submission references.
   */
  private async updateReviewSummation(
    token: string,
    reviewSummationId: string,
    payload: ReviewSummationPayload,
  ): Promise<void> {
    const url = `${this.buildReviewSummationUrl()}/${reviewSummationId}`;

    try {
      await firstValueFrom(
        this.httpService.put(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
    } catch (error) {
      const errorDetails = this.extractHttpError(error);
      this.logger.error({
        message: 'Failed to update review summation',
        url,
        payload,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      if (errorDetails.statusCode === 400 || errorDetails.statusCode === 404) {
        throw new BadRequestException(
          `Failed to update review summation: ${errorDetails.message}`,
        );
      }
      throw new Error(
        `Failed to update review summation: ${errorDetails.message}`,
      );
    }
  }

  /**
   * Completes the originating review record after final SYSTEM summations are persisted.
   */
  private async completeSystemReviewIfNeeded(
    token: string,
    reviewId: string | undefined,
    finalScore: number,
    testPhase: string,
    context?: SystemReviewCompletionContext,
  ): Promise<void> {
    if (this.normalizeTestPhase(testPhase) !== 'system') {
      return;
    }

    const normalizedReviewId = reviewId?.trim();
    const reviewIds = new Set<string>();
    if (normalizedReviewId) {
      reviewIds.add(normalizedReviewId);
    }

    for (const fallbackReviewId of await this.findPendingSystemReviewIds(
      token,
      context,
    )) {
      reviewIds.add(fallbackReviewId);
    }

    if (reviewIds.size === 0) {
      return;
    }

    const payload = {
      status: 'COMPLETED',
      reviewDate: new Date().toISOString(),
      finalScore,
    };

    for (const reviewIdToComplete of reviewIds) {
      const url = this.buildReviewUrl(reviewIdToComplete);
      try {
        await firstValueFrom(
          this.httpService.patch(url, payload, {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          }),
        );
      } catch (error) {
        const errorDetails = this.extractHttpError(error);
        this.logger.error({
          message: 'Failed to mark system review as completed',
          url,
          payload,
          reviewId: reviewIdToComplete,
          statusCode: errorDetails.statusCode ?? null,
          responseBody: errorDetails.responseBody ?? null,
          error: errorDetails.message,
        });
        throw new Error(
          `Failed to mark review ${reviewIdToComplete} as COMPLETED: ${errorDetails.message}`,
        );
      }
    }
  }

  /**
   * Finds pending review-api SYSTEM review records for a completed scorer callback
   * when the runner did not include a review ID. Matching by submission and
   * configured scorecard lets Marathon Match review phases close after scoring.
   * @param token M2M token for review-api.
   * @param context Challenge/submission context from the scorer callback.
   * @returns Review IDs that are still pending or in progress.
   */
  private async findPendingSystemReviewIds(
    token: string,
    context?: SystemReviewCompletionContext,
  ): Promise<string[]> {
    const challengeId = this.asString(context?.challengeId);
    const submissionId = this.asString(context?.submissionId);
    if (!challengeId || !submissionId) {
      return [];
    }

    const params: Record<string, string> = {
      challengeId,
      perPage: '100',
      submissionId,
      thin: 'true',
    };
    const url = this.buildReviewsUrl();
    const expectedScorecardId = this.asString(context?.scorecardId);

    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params,
        }),
      );

      return this.extractReviewArray(response.data)
        .filter((review) =>
          this.matchesPendingSystemReview(review, expectedScorecardId),
        )
        .map((review) => this.asString(review.id))
        .filter((id): id is string => Boolean(id));
    } catch (error) {
      const errorDetails = this.extractHttpError(error);
      this.logger.warn({
        message:
          'Unable to look up pending system reviews for scorer completion fallback.',
        url,
        params,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      return [];
    }
  }

  /**
   * Checks whether a review-api record is a pending system review candidate.
   * @param review Review object returned by review-api.
   * @param expectedScorecardId Optional scorecard ID configured for MM review.
   * @returns True when the review can be completed by the system scorer fallback.
   */
  private matchesPendingSystemReview(
    review: Record<string, unknown>,
    expectedScorecardId?: string,
  ): boolean {
    const reviewId = this.asString(review.id);
    if (!reviewId) {
      return false;
    }

    const normalizedStatus = this.asString(review.status)?.toUpperCase();
    if (normalizedStatus !== 'PENDING' && normalizedStatus !== 'IN_PROGRESS') {
      return false;
    }

    const scorecardId = this.coalesceString(
      this.asString(review.scorecardId),
      this.asString(review.scoreCardId),
    );

    return !expectedScorecardId || scorecardId === expectedScorecardId;
  }

  /**
   * Resolves scorecard references to canonical review-api ids.
   * The input can be either the internal id or legacy id.
   */
  private async resolveScorecardId(
    token: string,
    scorecardId?: string,
  ): Promise<string | undefined> {
    const rawScorecardId = this.asString(scorecardId);
    if (!rawScorecardId) {
      return undefined;
    }

    const cached = this.scorecardIdLookupCache.get(rawScorecardId);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const url = this.buildScorecardLookupUrl(rawScorecardId);
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      const resolvedScorecardId = this.asString(
        this.asRecord(response.data).id,
      );
      if (!resolvedScorecardId) {
        this.logger.warn({
          message: 'Scorecard lookup response did not include an id',
          requestedScorecardId: rawScorecardId,
          url,
        });
        return undefined;
      }

      this.scorecardIdLookupCache.set(rawScorecardId, resolvedScorecardId);
      return resolvedScorecardId;
    } catch (error) {
      const errorDetails = this.extractHttpError(error);
      this.logger.warn({
        message:
          'Unable to resolve scorecardId from review-api. scorecardId will be omitted from review summation payload.',
        requestedScorecardId: rawScorecardId,
        url,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      if (errorDetails.statusCode === 400 || errorDetails.statusCode === 404) {
        this.scorecardIdLookupCache.set(rawScorecardId, null);
      }
      return undefined;
    }
  }

  /**
   * Builds the review-api reviewSummations endpoint URL.
   */
  private buildReviewSummationUrl(): string {
    return `${this.buildReviewApiBaseUrl()}/reviewSummations`;
  }

  /**
   * Builds the review-api reviews endpoint URL.
   */
  private buildReviewsUrl(): string {
    return `${this.buildReviewApiBaseUrl()}/reviews`;
  }

  /**
   * Builds a submission-api base URL without trailing slashes.
   */
  private buildSubmissionApiBaseUrl(submissionApiUrl: string): string {
    return submissionApiUrl.replace(/\/+$/, '');
  }

  /**
   * Builds the review-api scorecard lookup URL.
   */
  private buildScorecardLookupUrl(scorecardId: string): string {
    return `${this.buildReviewApiBaseUrl()}/scorecards/${encodeURIComponent(scorecardId)}`;
  }

  /**
   * Builds the review-api review endpoint URL for one review record.
   */
  private buildReviewUrl(reviewId: string): string {
    return `${this.buildReviewApiBaseUrl()}/reviews/${encodeURIComponent(reviewId)}`;
  }

  /**
   * Builds the canonical review-api v6 base URL.
   */
  private buildReviewApiBaseUrl(): string {
    const baseUrl = (
      process.env.REVIEW_API_URL || 'https://api.topcoder-dev.com'
    ).replace(/\/+$/, '');
    const normalizedBase = baseUrl.replace(
      /\/(reviewSummations|reviews|scorecards)$/,
      '',
    );

    if (normalizedBase.endsWith('/v6')) {
      return normalizedBase;
    }

    return `${normalizedBase}/v6`;
  }

  /**
   * Normalizes example/provisional/system phase names.
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
   * Normalizes string score direction values into Prisma enum values.
   */
  private normalizeScoreDirection(
    value: string | undefined,
  ): ScoreDirection | undefined {
    const normalized = value?.trim().toUpperCase();
    if (normalized === ScoreDirection.MAXIMIZE) {
      return ScoreDirection.MAXIMIZE;
    }
    if (normalized === ScoreDirection.MINIMIZE) {
      return ScoreDirection.MINIMIZE;
    }
    return undefined;
  }

  /**
   * Converts a boolean maximize flag into a score direction.
   */
  private normalizeScoreDirectionFromBoolean(
    isMaximize: boolean | null,
  ): ScoreDirection | undefined {
    if (isMaximize === null) {
      return undefined;
    }
    return isMaximize ? ScoreDirection.MAXIMIZE : ScoreDirection.MINIMIZE;
  }

  /**
   * Keeps runner progress values inside the review summation 0..1 contract.
   */
  private clampProgress(value: number): number {
    if (!Number.isFinite(value)) {
      return 0;
    }

    return Math.min(1, Math.max(0, value));
  }

  /**
   * Converts a numeric value to a non-negative integer when possible.
   */
  private normalizeNonNegativeInteger(
    value: number | undefined,
  ): number | undefined {
    if (value === undefined || value === null || !Number.isFinite(value)) {
      return undefined;
    }

    return Math.max(0, Math.floor(value));
  }

  /**
   * Converts optional runner payload fragments into Prisma JSON input values.
   * @param value Callback fragment from the runner.
   * @returns JSON input value when present, otherwise undefined so Prisma leaves the field unset.
   * Used by validation-run persistence for current/impacted review details.
   */
  private toOptionalJson(value: unknown): Prisma.InputJsonValue | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    return value as Prisma.InputJsonValue;
  }

  /**
   * Resolves total test count from runner metadata.
   */
  private resolveTotalTests(
    metadata: Record<string, unknown>,
  ): number | undefined {
    const tests = this.asRecord(metadata.tests);
    const totalTests =
      this.toNumber(metadata.numberOfTests) ?? this.toNumber(tests.total);

    return totalTests === null
      ? undefined
      : this.normalizeNonNegativeInteger(totalTests);
  }

  /**
   * Counts test score entries emitted by the runner.
   */
  private countCompletedTestScores(metadata: Record<string, unknown>): number {
    const testScores = metadata.testScores;
    return Array.isArray(testScores) ? testScores.length : 0;
  }

  /**
   * Counts test score entries that represent failed test execution.
   */
  private countFailedTestScores(metadata: Record<string, unknown>): number {
    const testScores = metadata.testScores;
    if (!Array.isArray(testScores)) {
      return 0;
    }

    let failedTests = 0;
    for (const testScore of testScores) {
      const entry = this.asRecord(testScore);
      const score = this.toNumber(entry.score);
      const error = this.asString(entry.error);
      const hasScore = Object.prototype.hasOwnProperty.call(entry, 'score');
      if (
        (hasScore && score === null) ||
        (score !== null && (score < 0 || score > MAX_REVIEW_SCORE)) ||
        error
      ) {
        failedTests += 1;
      }
    }

    return failedTests;
  }

  /**
   * Parses boolean values from booleans, string booleans, and numeric flags.
   */
  private parseBooleanFlag(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }

    if (typeof value === 'number') {
      if (value === 1) {
        return true;
      }
      if (value === 0) {
        return false;
      }
    }

    return null;
  }

  /**
   * Safely clones record-like values and rejects arrays.
   */
  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return { ...(value as Record<string, unknown>) };
  }

  /**
   * Converts strings, numbers, and bigint values into trimmed strings.
   */
  private asString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint'
    ) {
      return undefined;
    }

    const stringValue = `${value}`.trim();
    return stringValue.length > 0 ? stringValue : undefined;
  }

  /**
   * Converts strings and numbers into finite numbers.
   */
  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  /**
   * Ensures review scores can be safely persisted in review-api summations.
   * Negative values remain valid because the scorer uses them as failed-test
   * sentinels; non-finite values and values above Java Long.MAX_VALUE are rejected.
   * @param score Score value received from the runner or legacy review payload.
   * @param label Human-readable score context for error messages.
   * @throws BadRequestException when the score is non-numeric, non-finite, or too large.
   */
  private validateReviewScore(
    score: unknown,
    label: string,
  ): asserts score is number {
    if (
      typeof score !== 'number' ||
      !Number.isFinite(score) ||
      score > MAX_REVIEW_SCORE
    ) {
      throw new BadRequestException(
        `${label} must be a finite number no greater than ${MAX_REVIEW_SCORE_LABEL}.`,
      );
    }
  }

  /**
   * Returns the first non-empty string from the provided values.
   */
  private coalesceString(
    ...values: Array<string | undefined>
  ): string | undefined {
    for (const value of values) {
      if (value && value.trim().length > 0) {
        return value;
      }
    }

    return undefined;
  }

  /**
   * Extracts submission arrays from direct-list and wrapped API responses.
   */
  private extractSubmissionArray(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((entry) => this.asRecord(entry));
    }

    const wrapper = this.asRecord(data);
    const resultValue = wrapper.result;
    if (Array.isArray(resultValue)) {
      return resultValue.map((entry) => this.asRecord(entry));
    }

    const resultRecord = this.asRecord(resultValue);
    if (Array.isArray(resultRecord.content)) {
      return resultRecord.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(wrapper.data)) {
      return wrapper.data.map((entry) => this.asRecord(entry));
    }

    return [];
  }

  /**
   * Extracts one submission object from direct and wrapped submission-api responses.
   */
  private extractSubmissionRecord(
    data: unknown,
  ): Record<string, unknown> | undefined {
    const records = this.extractSubmissionArray(data);
    if (records.length > 0) {
      return records[0];
    }

    const direct = this.asRecord(data);
    const result = this.asRecord(direct.result);
    if (Object.keys(result).length > 0) {
      return result;
    }

    const dataRecord = this.asRecord(direct.data);
    if (Object.keys(dataRecord).length > 0) {
      return dataRecord;
    }

    return Object.keys(direct).length > 0 ? direct : undefined;
  }

  /**
   * Extracts the challenge display name from direct and wrapped challenge-api responses.
   */
  private extractChallengeName(data: unknown): string | undefined {
    const challenge = this.extractChallengeRecord(data);
    return this.coalesceString(
      this.asString(challenge.name),
      this.asString(challenge.title),
      this.asString(challenge.challengeName),
    );
  }

  /**
   * Extracts one challenge object from direct and wrapped challenge-api responses.
   */
  private extractChallengeRecord(data: unknown): Record<string, unknown> {
    const direct = this.asRecord(data);
    if (Object.keys(direct).length === 0) {
      return {};
    }

    const result = this.asRecord(direct.result);
    const resultContent = this.asRecord(result.content);
    if (Object.keys(resultContent).length > 0) {
      return resultContent;
    }
    if (Object.keys(result).length > 0) {
      return result;
    }

    const dataRecord = this.asRecord(direct.data);
    if (Object.keys(dataRecord).length > 0) {
      return dataRecord;
    }

    return direct;
  }

  /**
   * Extracts review-api review summation arrays from paginated and wrapped responses.
   */
  private extractReviewSummationArray(
    data: unknown,
  ): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((entry) => this.asRecord(entry));
    }

    const wrapper = this.asRecord(data);
    if (Array.isArray(wrapper.data)) {
      return wrapper.data.map((entry) => this.asRecord(entry));
    }

    const resultRecord = this.asRecord(wrapper.result);
    if (Array.isArray(resultRecord.content)) {
      return resultRecord.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(resultRecord.data)) {
      return resultRecord.data.map((entry) => this.asRecord(entry));
    }

    return [];
  }

  /**
   * Extracts review-api review arrays from paginated and wrapped responses.
   */
  private extractReviewArray(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((entry) => this.asRecord(entry));
    }

    const wrapper = this.asRecord(data);
    if (Array.isArray(wrapper.data)) {
      return wrapper.data.map((entry) => this.asRecord(entry));
    }

    const resultRecord = this.asRecord(wrapper.result);
    if (Array.isArray(resultRecord.content)) {
      return resultRecord.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(resultRecord.data)) {
      return resultRecord.data.map((entry) => this.asRecord(entry));
    }

    return [];
  }

  /**
   * Parses the total page count from submission-api response headers.
   */
  private parseTotalPages(
    headers: Record<string, unknown> | undefined,
  ): number {
    if (!headers) {
      return 1;
    }

    const totalPagesValue =
      headers['x-total-pages'] ??
      headers['X-Total-Pages'] ??
      headers['x-total-page'];
    const totalPages = Number.parseInt(
      this.asString(totalPagesValue) ?? '1',
      10,
    );
    return Number.isFinite(totalPages) && totalPages > 0 ? totalPages : 1;
  }

  /**
   * Resolves the best available submission timestamp across current and legacy
   * submission-api payload shapes.
   */
  private resolveSubmissionDate(
    submission: Record<string, unknown> | undefined,
  ): string | undefined {
    if (!submission) {
      return undefined;
    }

    return this.coalesceString(
      this.asString(submission.submittedDate),
      this.asString(submission.receivedDate),
      this.asString(submission.receivedAt),
      this.asString(submission.createdAt),
      this.asString(submission.updatedAt),
      this.asString(submission.created),
    );
  }

  /**
   * Compares ISO timestamps lexicographically while tolerating missing values.
   */
  private compareIsoDateStrings(
    left: string | undefined,
    right: string | undefined,
  ): number {
    if (left && right) {
      return left.localeCompare(right);
    }
    if (left) {
      return 1;
    }
    if (right) {
      return -1;
    }
    return 0;
  }

  /**
   * Extracts message/status/body details from Axios-style HTTP errors.
   */
  private extractHttpError(error: unknown): {
    message: string;
    statusCode?: number;
    responseBody?: unknown;
  } {
    const fallbackMessage =
      error instanceof Error ? error.message : String(error);

    if (!error || typeof error !== 'object') {
      return { message: fallbackMessage };
    }

    const response = (
      error as {
        response?: {
          status?: unknown;
          data?: unknown;
        };
      }
    ).response;

    const statusCode =
      typeof response?.status === 'number' ? response.status : undefined;
    const responseBody = response?.data;

    const responseMessage = this.asString(this.asRecord(responseBody).message);
    const message =
      statusCode !== undefined
        ? responseMessage
          ? `HTTP ${statusCode}: ${responseMessage}`
          : `HTTP ${statusCode}`
        : fallbackMessage;

    return {
      message,
      statusCode,
      responseBody,
    };
  }
}
