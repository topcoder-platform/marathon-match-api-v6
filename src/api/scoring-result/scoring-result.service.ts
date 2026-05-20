import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CompilationStatus,
  PhaseConfigType,
  ScoreDirection,
} from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { EcsService } from 'src/shared/modules/global/ecs.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export interface ScoringResultCallbackPayload {
  challengeId: string;
  submissionId: string;
  score: number;
  testPhase: string;
  reviewTypeId: string;
  reviewId?: string;
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

export interface ScoringProgressCallbackPayload {
  challengeId: string;
  submissionId: string;
  testPhase: string;
  reviewTypeId: string;
  progress: number;
  status: ScoringTestStatus;
  reviewId?: string;
  scorecardId?: string;
  completedTests?: number;
  totalTests?: number;
  failedTests?: number;
  message?: string;
  metadata?: Record<string, unknown>;
}

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
  reviewObject?: Record<string, unknown>;
  testPhase: string;
}

interface RelativeScoringSettings {
  challengeId?: string;
  submissionApiUrl?: string;
  enabled: boolean;
  scoreDirection: ScoreDirection;
}

interface ScoringResultConfigSummary {
  challengeId: string;
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
  memberId?: string;
  createdAt?: string;
  reviewObject: Record<string, unknown>;
  metadata: Record<string, unknown>;
  rawTestScores: RelativeTestScoreEntry[];
}

/**
 * Applies marathon-match review summation updates based on scorer callback data.
 * Relative-score propagation is handled here to keep ECS runner logic lightweight.
 */
@Injectable()
export class ScoringResultService {
  private readonly logger = LoggerService.forRoot('ScoringResultService');
  private readonly scorecardIdLookupCache = new Map<string, string | null>();

  constructor(
    private readonly httpService: HttpService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
    private readonly ecsService: EcsService,
  ) {}

  /**
   * Processes one scorer callback payload after verifying the challenge config exists,
   * then upserts all required review summations.
   */
  async processScoringResult(
    payload: ScoringResultCallbackPayload,
  ): Promise<void> {
    const normalizedPhase = this.normalizeTestPhase(payload.testPhase);
    const config = await this.requireScoringResultConfig(payload.challengeId);
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
        await this.completeSystemReviewIfNeeded(
          token,
          payload.reviewId,
          currentRelativeScore,
          normalizedPhase,
        );
        return;
      }
    }

    if (
      payload.currentReview &&
      Object.keys(payload.currentReview).length > 0
    ) {
      const currentReviewScore = await this.upsertFromLegacyReviewPayload(
        token,
        {
          legacyReview: payload.currentReview,
          fallbackSubmissionId: payload.submissionId,
          fallbackScore: payload.score,
          fallbackScorecardId,
          fallbackMetadata,
          testPhase: normalizedPhase,
        },
      );

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
      score: payload.status === ScoringTestStatus.Success ? 0 : -1,
      scorecardId: fallbackScorecardId,
      metadata,
      testPhase: normalizedPhase,
    });

    await this.upsertReviewSummation(token, normalizedPhase, reviewPayload);
  }

  /**
   * Dispatches the SYSTEM scorer task for a pending Marathon Match review.
   * @param reviewId Review identifier created in review-api.
   * @param submissionId Submission identifier to score.
   * @param challengeId Challenge identifier used to resolve Marathon Match config.
   */
  async triggerSystemScore(
    reviewId: string,
    submissionId: string,
    challengeId: string,
  ): Promise<void> {
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

    this.logger.log({
      message: 'Triggered Marathon Match SYSTEM score dispatch.',
      challengeId,
      submissionId,
      reviewId,
      taskArn: launchResult.taskArn,
      taskId: launchResult.taskId,
    });
  }

  /**
   * Recomputes relative scores for the latest submission from each member.
   * Returns false when relative scoring cannot be applied and the caller should
   * fall back to direct review upserts.
   */
  private async processRelativeScoring(
    token: string,
    payload: ScoringResultCallbackPayload,
    testPhase: string,
    fallbackMetadata: Record<string, unknown>,
    fallbackScorecardId: string | undefined,
    settings: RelativeScoringSettings,
  ): Promise<number | undefined> {
    if (!settings.challengeId || !settings.submissionApiUrl) {
      this.logger.warn({
        message:
          'Relative scoring is enabled but challenge context is incomplete. Falling back to direct review upsert.',
        challengeId: settings.challengeId ?? null,
        submissionApiUrl: settings.submissionApiUrl ?? null,
        submissionId: payload.submissionId,
        testPhase,
      });
      return undefined;
    }

    const submissions = await this.fetchChallengeSubmissions(
      token,
      settings.submissionApiUrl,
      settings.challengeId,
    );
    const currentSubmission = submissions.find(
      (submission) =>
        this.asString(submission.id) === payload.submissionId.trim(),
    );
    const currentMemberId = this.asString(currentSubmission?.memberId);

    const currentReview = this.buildCurrentRelativeReviewRecord({
      payload,
      fallbackMetadata,
      fallbackScorecardId,
      existingReviewObject: this.findPhaseReviewSummation(
        currentSubmission,
        testPhase,
      ),
      memberId: currentMemberId,
      createdAt: this.asString(currentSubmission?.created),
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
      currentMemberId,
    );

    const reviewsToRecompute = [...impactedReviews, currentReview];
    const bestScores = this.computeBestScores(
      reviewsToRecompute,
      settings.scoreDirection,
    );

    const relativeReviewPayloads = reviewsToRecompute.map((reviewRecord) =>
      this.buildRelativeReviewPayload(
        reviewRecord,
        bestScores,
        settings.scoreDirection,
        fallbackScorecardId,
        testPhase,
      ),
    );

    const currentReviewPayload =
      relativeReviewPayloads[relativeReviewPayloads.length - 1];

    for (let index = 0; index < relativeReviewPayloads.length; index += 1) {
      const reviewPayload = relativeReviewPayloads[index];
      const reviewId = this.asString(reviewPayload.reviewObject.id);

      if (index === relativeReviewPayloads.length - 1 && !reviewId) {
        await this.createReviewSummation(token, reviewPayload.payload);
        continue;
      }

      if (!reviewId) {
        this.logger.warn({
          message:
            'Skipping impacted relative review update because reviewSummation id is missing.',
          submissionId: reviewPayload.payload.submissionId,
          testPhase,
        });
        continue;
      }

      await this.updateReviewSummation(token, reviewId, reviewPayload.payload);
    }

    return currentReviewPayload?.payload.aggregateScore;
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
   * Selects the latest scored submission per member for the requested phase.
   */
  private selectLatestRelativeReviewRecords(
    submissions: Record<string, unknown>[],
    testPhase: string,
    reviewTypeId: string,
    excludedSubmissionId: string,
    excludedMemberId?: string,
  ): RelativeReviewRecord[] {
    const latestByMember = new Map<
      string,
      {
        submissionId: string;
        memberId?: string;
        createdAt?: string;
        reviewObject: Record<string, unknown>;
      }
    >();

    for (const submission of submissions) {
      const submissionId = this.asString(submission.id);
      if (!submissionId || submissionId === excludedSubmissionId) {
        continue;
      }

      const memberId = this.asString(submission.memberId);
      if (excludedMemberId && memberId === excludedMemberId) {
        continue;
      }

      const reviewObject = this.findPhaseReviewSummation(submission, testPhase);
      if (!reviewObject) {
        continue;
      }

      const key = memberId ?? `submission:${submissionId}`;
      const createdAt = this.asString(submission.created);
      const existing = latestByMember.get(key);

      if (
        !existing ||
        this.compareIsoDateStrings(createdAt, existing.createdAt) >= 0
      ) {
        latestByMember.set(key, {
          submissionId,
          memberId,
          createdAt,
          reviewObject,
        });
      }
    }

    return Array.from(latestByMember.values())
      .map((entry) =>
        this.buildRelativeReviewRecord({
          createdAt: entry.createdAt,
          memberId: entry.memberId,
          reviewObject: entry.reviewObject,
          reviewTypeId,
          submissionId: entry.submissionId,
          testPhase,
        }),
      )
      .filter((entry): entry is RelativeReviewRecord => entry !== null);
  }

  /**
   * Builds the current submission review object used for relative scoring.
   */
  private buildCurrentRelativeReviewRecord(args: {
    payload: ScoringResultCallbackPayload;
    fallbackMetadata: Record<string, unknown>;
    fallbackScorecardId?: string;
    existingReviewObject: Record<string, unknown> | null;
    memberId?: string;
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
      memberId: args.memberId,
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
    memberId?: string;
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
      memberId: args.memberId,
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
   */
  private computeBestScores(
    reviewRecords: RelativeReviewRecord[],
    scoreDirection: ScoreDirection,
  ): Map<string, number> {
    const bestScores = new Map<string, number>();

    for (const reviewRecord of reviewRecords) {
      for (const testScore of reviewRecord.rawTestScores) {
        if (testScore.score < 0) {
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
  ): {
    reviewObject: Record<string, unknown>;
    payload: ReviewSummationPayload;
  } {
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
          failedTests > 0
            ? ScoringTestStatus.Failed
            : ScoringTestStatus.Success,
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
        reviewObject,
        testPhase,
      }),
    };
  }

  /**
   * Converts one raw testcase score into its 0..100 relative score.
   * Zero raw or best scores receive no relative credit, including a 0-to-0 tie.
   */
  private calculateRelativeScore(
    rawScore: number,
    bestScore: number | undefined,
  ): number {
    if (rawScore < 0 || bestScore === undefined) {
      return 0;
    }

    if (bestScore === 0 || rawScore === 0) {
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

      if (!testcase || score === null) {
        continue;
      }

      result.push({
        testcase,
        score,
        error: this.asString(entry.error),
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
    const metadata = this.asRecord(input.metadata);

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
      reviewedDate: new Date().toISOString(),
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

    return normalized;
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
    const completedTests =
      totalTests ?? this.countCompletedTestScores(metadata);
    const failedTests = this.countFailedTestScores(metadata);
    const status =
      finalScore < 0 || failedTests > 0
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
    const message = this.asString(progress.message);
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
   * Creates or updates one phase review summation for a submission.
   * @param token M2M token for review-api.
   * @param testPhase Normalized or raw phase value.
   * @param payload Review summation payload to persist.
   */
  private async upsertReviewSummation(
    token: string,
    testPhase: string,
    payload: ReviewSummationPayload,
  ): Promise<void> {
    const existingReview = await this.findExistingReviewSummation(
      token,
      payload.submissionId,
      testPhase,
    );
    const reviewSummationId = this.asString(existingReview?.id);

    if (reviewSummationId) {
      await this.updateReviewSummation(token, reviewSummationId, payload);
      return;
    }

    await this.createReviewSummation(token, payload);
  }

  /**
   * Looks up an existing review summation for one submission and scoring phase.
   * @param token M2M token for review-api.
   * @param submissionId Submission ID.
   * @param testPhase Example, provisional, or system scoring phase.
   * @returns The matching review summation record, or null when none exists.
   */
  private async findExistingReviewSummation(
    token: string,
    submissionId: string,
    testPhase: string,
  ): Promise<Record<string, unknown> | null> {
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

    return (
      reviewSummations.find((review) =>
        this.matchesPhaseReview(review, normalizedPhase),
      ) ??
      reviewSummations[0] ??
      null
    );
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
   * Completes the originating review record after SYSTEM scoring has been persisted.
   */
  private async completeSystemReviewIfNeeded(
    token: string,
    reviewId: string | undefined,
    finalScore: number,
    testPhase: string,
  ): Promise<void> {
    if (this.normalizeTestPhase(testPhase) !== 'system') {
      return;
    }

    const normalizedReviewId = reviewId?.trim();
    if (!normalizedReviewId) {
      return;
    }

    const url = this.buildReviewUrl(normalizedReviewId);
    const payload = {
      status: 'COMPLETED',
      reviewDate: new Date().toISOString(),
      finalScore,
    };

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
        reviewId: normalizedReviewId,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      throw new Error(
        `Failed to mark review ${normalizedReviewId} as COMPLETED: ${errorDetails.message}`,
      );
    }
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
      if ((score !== null && score < 0) || error) {
        failedTests += 1;
      }
    }

    return failedTests;
  }

  /**
   * Parses boolean values from booleans and string booleans.
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
