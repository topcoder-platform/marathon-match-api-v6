import { HttpService } from '@nestjs/axios';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompilationStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { resolveSubmissionApiBaseUrl } from 'src/shared/config/submission-api-url.config';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import {
  EcsService,
  MarathonMatchScorerTaskLaunchResult,
} from 'src/shared/modules/global/ecs.service';
import { BaseEventHandler } from 'src/shared/modules/kafka/base-event.handler';
import {
  MarathonMatchSubmissionEventEnvelope,
  MarathonMatchSubmissionEventPayload,
  MarathonMatchSubmissionKafkaMessage,
} from 'src/shared/modules/kafka/handlers/marathon-match-submission.handler';
import { KafkaHandlerRegistry } from 'src/shared/modules/kafka/kafka-handler.registry';

interface ChallengePhaseResponse {
  id?: string;
  phaseId?: string;
  isOpen?: boolean;
  actualStartDate?: string | number | Date | null;
  scheduledStartDate?: string | number | Date | null;
}

interface ChallengeResponse {
  currentPhase?: ChallengePhaseResponse;
  phases?: ChallengePhaseResponse[];
  result?: {
    currentPhase?: ChallengePhaseResponse;
    phases?: ChallengePhaseResponse[];
    content?: {
      currentPhase?: ChallengePhaseResponse;
      phases?: ChallengePhaseResponse[];
    };
  };
}

interface OpenPhaseResolution {
  phaseIds: string[];
  phaseIdentifiers: string[];
}

interface SkippedSubmissionScoringConfig {
  reviewScorecardId?: string | null;
}

interface SkippedSubmissionScoringPayload {
  submissionId: string;
  challengeId: string;
  testPhase: string;
  scorecardId?: string;
  reason: string;
  details?: Record<string, unknown>;
}

interface SkippedReviewSummationPayload {
  submissionId: string;
  aggregateScore: number;
  isPassing: boolean;
  reviewedDate: string;
  scorecardId?: string;
  isFinal?: boolean;
  isProvisional?: boolean;
  isExample?: boolean;
  metadata: Record<string, unknown>;
}

/**
 * Consumes `marathonmatch.submission.received` events and prepares scorer task
 * orchestration by resolving configured challenge phase and tester readiness.
 */
@Injectable()
export class MarathonMatchSubmissionHandler
  extends BaseEventHandler
  implements OnModuleInit
{
  private readonly topic = 'marathonmatch.submission.received';
  private readonly challengeApiBaseUrl =
    process.env.CHALLENGE_API_URL?.replace(/\/+$/, '') ||
    'https://api.topcoder-dev.com';

  constructor(
    private readonly handlerRegistry: KafkaHandlerRegistry,
    private readonly prisma: PrismaService,
    loggerService: LoggerService,
    private readonly m2mService: M2MService,
    private readonly httpService: HttpService,
    private readonly ecsService: EcsService,
  ) {
    super(loggerService);
    this.logger = LoggerService.forRoot('MarathonMatchSubmissionHandler');
  }

  /**
   * Registers the handler for the marathon match submission topic.
   * @returns void
   */
  onModuleInit(): void {
    this.handlerRegistry.registerHandler(this.topic, this);
    this.logger.log(`Registered handler for topic: ${this.topic}`);
  }

  /**
   * Returns the Kafka topic this handler consumes.
   * @returns Topic name.
   */
  getTopic(): string {
    return this.topic;
  }

  /**
   * Processes a marathon match submission message.
   * @param message Kafka message parsed from the body. Supports both event-bus
   * envelope (`{ topic, payload }`) and direct payload publish formats.
   * @returns Resolves when the message is fully handled.
   * @throws Error When required fields are missing, config is missing, challenge API
   * lookup fails, tester compilation is not successful, or ECS task launch fails.
   */
  async handle(message: MarathonMatchSubmissionKafkaMessage): Promise<void> {
    try {
      this.logger.log({
        message: 'Processing marathon match submission event',
        topic: this.topic,
        payload: message,
      });

      if (!this.validateMessage(message)) {
        this.logger.warn('Invalid message received');
        return;
      }

      const submissionPayload = this.resolveSubmissionPayload(message);
      const submissionId = (submissionPayload.submissionId ?? '').trim();
      const challengeId = (submissionPayload.challengeId ?? '').trim();
      const memberId = (submissionPayload.memberId ?? '').trim();
      if (!submissionId || !challengeId) {
        throw new Error(
          'Missing required message fields: submissionId and challengeId are required.',
        );
      }

      const config = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
        include: { phaseConfigs: true, tester: true },
      });

      if (!config) {
        throw new Error(
          `Marathon match config not found for challenge ${challengeId}.`,
        );
      }

      if (config.active === false) {
        await this.markSubmissionScoringSkipped(
          submissionId,
          challengeId,
          'Marathon Match scoring skipped because the challenge configuration is inactive.',
          config,
          { configId: config.id },
        );
        this.logger.log(
          `Marathon match config ${config.id} is inactive. Skipping submission ${submissionId}.`,
        );
        return;
      }

      const openPhaseResolution =
        await this.getOpenPhaseResolution(challengeId);
      if (openPhaseResolution.phaseIdentifiers.length === 0) {
        await this.markSubmissionScoringSkipped(
          submissionId,
          challengeId,
          'Marathon Match scoring skipped because the challenge has no open scoring phase.',
          config,
          { configId: config.id },
        );
        this.logger.log(
          `Challenge ${challengeId} has no open phase. Skipping submission ${submissionId}.`,
        );
        return;
      }

      const matchingPhaseConfigs = this.findMatchingPhaseConfigs(
        config.phaseConfigs,
        openPhaseResolution.phaseIdentifiers,
      );
      if (matchingPhaseConfigs.length === 0) {
        await this.markSubmissionScoringSkipped(
          submissionId,
          challengeId,
          'Marathon Match scoring skipped because no configured phase matches the open challenge phase.',
          config,
          {
            configId: config.id,
            openPhaseIds: openPhaseResolution.phaseIds,
            openPhaseIdentifiers: openPhaseResolution.phaseIdentifiers,
          },
        );
        this.logger.log({
          message:
            'No configured marathon match phase for open challenge phases',
          challengeId,
          submissionId,
          openPhaseIds: openPhaseResolution.phaseIds,
          openPhaseIdentifiers: openPhaseResolution.phaseIdentifiers,
        });
        return;
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        throw new Error(
          `Tester ${config.testerId} for config ${config.id} is not ready. Current compilation status: ${config.tester.compilationStatus}.`,
        );
      }

      const submissionApiBaseUrl = resolveSubmissionApiBaseUrl({
        configuredUrl: config.submissionApiUrl,
        fallbackApiBaseUrl: this.challengeApiBaseUrl,
        environmentUrls: [this.challengeApiBaseUrl],
      });

      const token = await this.m2mService.getM2MToken();
      if (!token) {
        throw new Error(
          'Unable to get M2M token for submission virus scan preflight.',
        );
      }

      const submission = await this.fetchSubmissionById(
        token,
        submissionApiBaseUrl,
        submissionId,
      );
      if (!this.isSubmissionCleanForScoring(submission)) {
        const skippedPhaseTasks: Array<Record<string, unknown>> = [];
        for (const matchingPhaseConfig of matchingPhaseConfigs) {
          const reason = `Marathon Match ${matchingPhaseConfig.configType} scoring skipped because the submission has not passed virus scanning.`;
          await this.upsertSkippedReviewSummation(token, {
            submissionId,
            challengeId,
            testPhase: matchingPhaseConfig.configType,
            reason,
            details: {
              configId: config.id,
              phaseConfigId: matchingPhaseConfig.id,
              virusScan: submission?.virusScan ?? null,
            },
            scorecardId: config.reviewScorecardId?.trim() || undefined,
          });
          skippedPhaseTasks.push({
            configType: matchingPhaseConfig.configType,
            phaseId: matchingPhaseConfig.phaseId,
            phaseConfigId: matchingPhaseConfig.id,
          });
        }

        this.logger.log({
          message:
            'Skipped Marathon Match submission scoring because submission is not virus-scanned.',
          challengeId,
          submissionId,
          virusScan: submission?.virusScan ?? null,
          skippedPhaseTasks,
        });
        return;
      }

      const launchedPhaseTasks: Array<Record<string, unknown>> = [];
      for (const matchingPhaseConfig of matchingPhaseConfigs) {
        const launchResult = await this.ecsService.launchScorerTask(
          config.challengeId,
          submissionId,
          {
            taskDefinitionName: config.taskDefinitionName,
            taskDefinitionVersion: config.taskDefinitionVersion,
          },
          {
            configType: matchingPhaseConfig.configType,
            startSeed: matchingPhaseConfig.startSeed,
            numberOfTests: matchingPhaseConfig.numberOfTests,
          },
          undefined,
          { memberId },
        );
        this.logSubmissionRunnerMapping(
          challengeId,
          submissionId,
          matchingPhaseConfig.configType,
          launchResult,
        );
        launchedPhaseTasks.push({
          configType: matchingPhaseConfig.configType,
          phaseId: matchingPhaseConfig.phaseId,
          phaseConfigId: matchingPhaseConfig.id,
          taskArn: launchResult.taskArn,
          taskId: launchResult.taskId,
          logGroup: launchResult.logGroup ?? null,
          logStreamPrefix: launchResult.logStreamPrefix ?? null,
          logStreamName: launchResult.logStreamName ?? null,
          cloudWatchLogsConsoleUrl:
            launchResult.cloudWatchLogsConsoleUrl ?? null,
        });
      }

      this.logger.log({
        message: 'Marathon match submission event processed successfully',
        challengeId,
        submissionId,
        openPhaseIds: openPhaseResolution.phaseIds,
        openPhaseIdentifiers: openPhaseResolution.phaseIdentifiers,
        matchedPhaseIds: matchingPhaseConfigs.map(
          (matchingPhaseConfig) => matchingPhaseConfig.phaseId,
        ),
        matchedPhaseConfigIds: matchingPhaseConfigs.map(
          (matchingPhaseConfig) => matchingPhaseConfig.id,
        ),
        matchedPhaseConfigTypes: matchingPhaseConfigs.map(
          (matchingPhaseConfig) => matchingPhaseConfig.configType,
        ),
        launchedPhaseTasks,
      });
    } catch (error) {
      const resolvedError =
        error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        {
          message: 'Failed to process marathon match submission event',
          topic: this.topic,
          error: resolvedError.message,
        },
        resolvedError.stack,
      );
      throw resolvedError;
    }
  }

  /**
   * Calls challenge-api-v6 and returns currently open phase identifiers.
   * @param challengeId Challenge identifier to fetch.
   * @returns Canonical open phase IDs plus backward-compatible identifiers.
   * @throws Error When token retrieval or HTTP request fails.
   */
  private async getOpenPhaseResolution(
    challengeId: string,
  ): Promise<OpenPhaseResolution> {
    const token = await this.m2mService.getM2MToken();
    if (!token) {
      throw new Error('Unable to get M2M token for challenge API call.');
    }

    const challengeUrl = `${this.challengeApiBaseUrl}/v6/challenges/${challengeId}`;
    const response = await firstValueFrom(
      this.httpService.get<ChallengeResponse>(challengeUrl, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );

    return this.extractOpenPhaseResolution(response.data);
  }

  /**
   * Fetches one submission record from submission-api-v6 before scorer dispatch.
   * @param token M2M token for submission-api-v6.
   * @param submissionApiUrl Configured submission-api-v6 base URL.
   * @param submissionId Submission identifier to fetch.
   * @returns Submission record when the API returns one, otherwise undefined.
   * @throws Error when the submission-api request fails.
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
   * Checks whether a submission can be safely downloaded by scorer runners.
   * @param submission Submission record returned by submission-api-v6.
   * @returns True only when `virusScan` is explicitly true.
   */
  private isSubmissionCleanForScoring(
    submission: Record<string, unknown> | undefined,
  ): boolean {
    return this.parseBooleanFlag(submission?.virusScan) === true;
  }

  /**
   * Extracts ordered open phase identifiers from challenge-api response payload.
   * @param responseBody HTTP response body from challenge-api.
   * @returns Canonical open phase IDs and backward-compatible identifiers.
   */
  private extractOpenPhaseResolution(
    responseBody: ChallengeResponse,
  ): OpenPhaseResolution {
    const challengeData = this.resolveChallengePayload(responseBody);
    const openPhases = this.resolveOpenPhases(challengeData.phases);
    const openPhaseIds = this.resolveOpenPhaseIds(openPhases);
    const openPhaseIdentifiers = this.resolveOpenPhaseIdentifiers(openPhases);
    if (openPhaseIdentifiers.length > 0) {
      return {
        phaseIds: openPhaseIds,
        phaseIdentifiers: openPhaseIdentifiers,
      };
    }

    const currentPhaseId = this.extractCanonicalPhaseId(
      challengeData.currentPhase,
    );
    return {
      phaseIds: currentPhaseId ? [currentPhaseId] : [],
      phaseIdentifiers: this.extractPhaseIdentifiers(
        challengeData.currentPhase,
      ),
    };
  }

  /**
   * Resolves open phases ordered by latest start, then timeline order.
   * @param phases Challenge phases.
   * @returns Ordered open phase payloads.
   */
  private resolveOpenPhases(
    phases?: ChallengePhaseResponse[],
  ): ChallengePhaseResponse[] {
    if (!Array.isArray(phases) || phases.length === 0) {
      return [];
    }

    const openPhases = phases
      .map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phase?.isOpen === true);
    if (openPhases.length === 0) {
      return [];
    }

    const orderedOpenPhases = openPhases
      .sort((left, right) => {
        const leftStartTimestamp = this.toTimestamp(
          left.phase.actualStartDate ?? left.phase.scheduledStartDate,
        );
        const rightStartTimestamp = this.toTimestamp(
          right.phase.actualStartDate ?? right.phase.scheduledStartDate,
        );

        if (leftStartTimestamp !== rightStartTimestamp) {
          return rightStartTimestamp - leftStartTimestamp;
        }

        return right.index - left.index;
      })
      .map(({ phase }) => phase);

    return orderedOpenPhases;
  }

  /**
   * Resolves canonical open challenge phase IDs ordered by priority.
   * @param phases Ordered open challenge phases.
   * @returns Ordered canonical phase IDs.
   */
  private resolveOpenPhaseIds(phases: ChallengePhaseResponse[]): string[] {
    const orderedPhaseIds = phases
      .map((phase) => this.extractCanonicalPhaseId(phase))
      .filter((phaseId): phaseId is string => Boolean(phaseId));

    return [...new Set(orderedPhaseIds)];
  }

  /**
   * Resolves open challenge phase identifiers ordered by priority.
   * Includes both canonical `phaseId` and legacy challenge-phase `id`.
   * @param phases Ordered open challenge phases.
   * @returns Ordered identifiers accepted for matching phase config rows.
   */
  private resolveOpenPhaseIdentifiers(
    phases: ChallengePhaseResponse[],
  ): string[] {
    return [
      ...new Set(
        phases.flatMap((phase) => this.extractPhaseIdentifiers(phase)),
      ),
    ];
  }

  /**
   * Logs the submission-to-runner-log mapping emitted at ECS launch time.
   * @param challengeId Challenge ID.
   * @param submissionId Submission ID.
   * @param launchResult ECS launch metadata with task/log fields.
   */
  private logSubmissionRunnerMapping(
    challengeId: string,
    submissionId: string,
    phaseConfigType: string,
    launchResult: MarathonMatchScorerTaskLaunchResult,
  ): void {
    this.logger.log({
      message: 'Submission runner log mapping ready',
      challengeId,
      submissionId,
      phaseConfigType,
      taskArn: launchResult.taskArn,
      taskId: launchResult.taskId,
      cluster: launchResult.cluster,
      containerName: launchResult.containerName,
      taskDefinition: launchResult.taskDefinition,
      logGroup: launchResult.logGroup ?? null,
      logStreamPrefix: launchResult.logStreamPrefix ?? null,
      logStreamName: launchResult.logStreamName ?? null,
      cloudWatchLogsConsoleUrl: launchResult.cloudWatchLogsConsoleUrl ?? null,
    });
  }

  /**
   * Persists a terminal failed phase summation when a configured submission
   * cannot be dispatched and would otherwise remain queued forever.
   * @param submissionId Submission ID from the Kafka event.
   * @param challengeId Challenge ID from the Kafka event.
   * @param reason Member-visible reason stored in summation metadata.
   * @param config Marathon Match config used to resolve scorecard context.
   * @param details Additional operator-facing metadata for the skip condition.
   * @param testPhase Scoring phase to mark failed, defaulting to provisional.
   * @returns Resolves after the review summation is created or updated.
   * @throws Error when token retrieval or review-api persistence fails.
   */
  private async markSubmissionScoringSkipped(
    submissionId: string,
    challengeId: string,
    reason: string,
    config: SkippedSubmissionScoringConfig,
    details?: Record<string, unknown>,
    testPhase = 'provisional',
  ): Promise<void> {
    const token = await this.m2mService.getM2MToken();
    if (!token) {
      throw new Error(
        'Unable to get M2M token for skipped submission scoring marker.',
      );
    }

    await this.upsertSkippedReviewSummation(token, {
      submissionId,
      challengeId,
      testPhase,
      reason,
      details,
      scorecardId: config.reviewScorecardId?.trim() || undefined,
    });
  }

  /**
   * Creates or updates the phase review summation used to show a skipped scoring
   * attempt as terminal instead of indefinitely queued.
   * @param token M2M token for review-api.
   * @param input Submission and skip context to persist.
   * @returns Resolves after the review-api write succeeds.
   * @throws Error when review-api rejects the read or write.
   */
  private async upsertSkippedReviewSummation(
    token: string,
    input: SkippedSubmissionScoringPayload,
  ): Promise<void> {
    const payload = this.buildSkippedReviewSummationPayload(input);
    const existingReviewSummations = await this.findExistingReviewSummations(
      token,
      input.submissionId,
      input.testPhase,
    );

    if (existingReviewSummations.length === 0) {
      await this.createSkippedReviewSummation(token, payload);
      return;
    }

    let updatedExistingReviewSummation = false;
    for (const reviewSummation of existingReviewSummations) {
      const reviewSummationId = this.asString(reviewSummation.id);
      if (reviewSummationId) {
        await this.updateSkippedReviewSummation(
          token,
          reviewSummationId,
          payload,
        );
        updatedExistingReviewSummation = true;
      }
    }

    if (!updatedExistingReviewSummation) {
      await this.createSkippedReviewSummation(token, payload);
    }
  }

  /**
   * Builds a failed phase review summation payload for skipped dispatch.
   * @param input Submission and skip context to persist.
   * @returns Review summation payload accepted by review-api-v6.
   */
  private buildSkippedReviewSummationPayload(
    input: SkippedSubmissionScoringPayload,
  ): SkippedReviewSummationPayload {
    const now = new Date().toISOString();
    const reviewTypeId = process.env.REVIEW_TYPE_ID?.trim();
    const normalizedPhase = this.normalizeTestPhase(input.testPhase);
    const testProgressDetails: Record<string, unknown> = {
      message: input.reason,
      progress: 1,
      status: 'FAILED',
      updatedAt: now,
    };
    const metadata: Record<string, unknown> = {
      challengeId: input.challengeId,
      marathonMatchScoringSkipped: true,
      marathonMatchScoringSkipReason: input.reason,
      testProgress: 1,
      testProgressDetails,
      testStatus: 'FAILED',
      testType: normalizedPhase,
    };

    if (normalizedPhase !== 'example') {
      testProgressDetails.testProcess = normalizedPhase;
      metadata.testProcess = normalizedPhase;
    }
    if (reviewTypeId) {
      metadata.reviewTypeId = reviewTypeId;
    }
    if (input.details && Object.keys(input.details).length > 0) {
      metadata.marathonMatchScoringSkipDetails = input.details;
    }

    return {
      submissionId: input.submissionId,
      aggregateScore: -1,
      isPassing: false,
      reviewedDate: now,
      scorecardId: input.scorecardId,
      ...(normalizedPhase === 'system' ? { isFinal: true } : {}),
      ...(normalizedPhase === 'provisional' ? { isProvisional: true } : {}),
      ...(normalizedPhase === 'example' ? { isExample: true } : {}),
      metadata,
    };
  }

  /**
   * Finds phase summations for a submission so skipped markers are
   * idempotent across Kafka retries.
   * @param token M2M token for review-api.
   * @param submissionId Submission ID to look up.
   * @param testPhase Example, provisional, or system scoring phase.
   * @returns Existing phase summation rows.
   */
  private async findExistingReviewSummations(
    token: string,
    submissionId: string,
    testPhase: string,
  ): Promise<Record<string, unknown>[]> {
    const normalizedPhase = this.normalizeTestPhase(testPhase);
    const params: Record<string, string> = {
      metadata: 'true',
      submissionId,
    };

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
    const matchingReviewSummations = reviewSummations.filter(
      (reviewSummation) =>
        this.matchesPhaseReview(reviewSummation, normalizedPhase),
    );

    if (matchingReviewSummations.length > 0) {
      return matchingReviewSummations;
    }

    return reviewSummations[0] ? [reviewSummations[0]] : [];
  }

  /**
   * Sends a create request for a skipped-dispatch phase summation.
   * @param token M2M token for review-api.
   * @param payload Review summation payload to persist.
   */
  private async createSkippedReviewSummation(
    token: string,
    payload: SkippedReviewSummationPayload,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.post(this.buildReviewSummationUrl(), payload, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      }),
    );
  }

  /**
   * Sends an update request for an existing skipped-dispatch summation.
   * @param token M2M token for review-api.
   * @param reviewSummationId Review summation ID to update.
   * @param payload Review summation payload to persist.
   */
  private async updateSkippedReviewSummation(
    token: string,
    reviewSummationId: string,
    payload: SkippedReviewSummationPayload,
  ): Promise<void> {
    await firstValueFrom(
      this.httpService.put(
        `${this.buildReviewSummationUrl()}/${encodeURIComponent(reviewSummationId)}`,
        payload,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        },
      ),
    );
  }

  /**
   * Builds the review-api review summation URL.
   * @returns Review summation endpoint URL.
   */
  private buildReviewSummationUrl(): string {
    const baseUrl = (
      process.env.REVIEW_API_URL || 'https://api.topcoder-dev.com'
    ).replace(/\/+$/, '');
    const normalizedBase = baseUrl.replace(/\/reviewSummations$/, '');

    if (normalizedBase.endsWith('/v6')) {
      return `${normalizedBase}/reviewSummations`;
    }

    return `${normalizedBase}/v6/reviewSummations`;
  }

  /**
   * Extracts review summation arrays from known review-api response shapes.
   * @param responseBody Raw review-api response payload.
   * @returns Review summation rows.
   */
  private extractReviewSummationArray(
    responseBody: unknown,
  ): Record<string, unknown>[] {
    const responseRecord = this.asRecord(responseBody);
    const data = responseRecord.data;
    if (Array.isArray(data)) {
      return data.filter((entry): entry is Record<string, unknown> =>
        this.isRecord(entry),
      );
    }
    if (Array.isArray(responseBody)) {
      return responseBody.filter((entry): entry is Record<string, unknown> =>
        this.isRecord(entry),
      );
    }

    return [];
  }

  /**
   * Checks whether a review summation belongs to the requested scoring phase.
   * @param reviewSummation Review summation row from review-api.
   * @param testPhase Normalized phase to match.
   * @returns True when the row belongs to the phase.
   */
  private matchesPhaseReview(
    reviewSummation: Record<string, unknown>,
    testPhase: string,
  ): boolean {
    const metadata = this.asRecord(reviewSummation.metadata);
    const metadataTestType = this.normalizeTestPhase(
      this.asString(metadata.testType),
    );
    const metadataTestProcess = this.normalizeTestPhase(
      this.asString(metadata.testProcess),
    );
    const metadataStage = this.asString(metadata.stage)?.toLowerCase();

    if (testPhase === 'example') {
      return (
        this.parseBooleanFlag(reviewSummation.isExample) === true ||
        metadataTestType === 'example'
      );
    }

    if (testPhase === 'system') {
      return (
        this.parseBooleanFlag(reviewSummation.isFinal) === true ||
        metadataTestType === 'system' ||
        metadataStage === 'final'
      );
    }

    return (
      this.parseBooleanFlag(reviewSummation.isProvisional) === true ||
      metadataTestType === 'provisional' ||
      metadataTestProcess === 'provisional'
    );
  }

  /**
   * Finds all configured phase mappings for the ordered open challenge phases.
   * @param phaseConfigs Stored phase configuration rows for a challenge.
   * @param openPhaseIdentifiers Open challenge phase identifiers ordered by priority.
   * @returns Matching phase configs in launch order.
   */
  private findMatchingPhaseConfigs<
    TPhaseConfig extends { phaseId: string; configType: string },
  >(
    phaseConfigs: TPhaseConfig[],
    openPhaseIdentifiers: string[],
  ): TPhaseConfig[] {
    const matchingPhaseConfigs: TPhaseConfig[] = [];
    const seenPhaseConfigs = new Set<string>();

    for (const openPhaseIdentifier of openPhaseIdentifiers) {
      const phaseConfigsForIdentifier = phaseConfigs
        .filter((phaseConfig) => phaseConfig.phaseId === openPhaseIdentifier)
        .sort((left, right) =>
          this.comparePhaseConfigLaunchPriority(
            left.configType,
            right.configType,
          ),
        );

      for (const matchingPhaseConfig of phaseConfigsForIdentifier) {
        const phaseConfigKey = [
          matchingPhaseConfig.phaseId,
          matchingPhaseConfig.configType.trim().toUpperCase(),
        ].join('::');
        if (seenPhaseConfigs.has(phaseConfigKey)) {
          continue;
        }

        seenPhaseConfigs.add(phaseConfigKey);
        matchingPhaseConfigs.push(matchingPhaseConfig);
      }
    }

    return matchingPhaseConfigs;
  }

  /**
   * Orders phase config launches deterministically when multiple configs share one open phase.
   * @param leftConfigType Left config type.
   * @param rightConfigType Right config type.
   * @returns Sort value for launch order.
   */
  private comparePhaseConfigLaunchPriority(
    leftConfigType: string,
    rightConfigType: string,
  ): number {
    const leftPriority = this.resolvePhaseConfigLaunchPriority(leftConfigType);
    const rightPriority =
      this.resolvePhaseConfigLaunchPriority(rightConfigType);
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    return leftConfigType
      .trim()
      .localeCompare(rightConfigType.trim(), 'en', { sensitivity: 'base' });
  }

  /**
   * Assigns a stable launch priority to known scorer phase config types.
   * @param configType Phase config type.
   * @returns Numeric priority where lower values launch first.
   */
  private resolvePhaseConfigLaunchPriority(configType: string): number {
    const normalizedConfigType = configType.trim().toUpperCase();
    if (normalizedConfigType === 'EXAMPLE') {
      return 0;
    }
    if (normalizedConfigType === 'PROVISIONAL') {
      return 1;
    }
    if (normalizedConfigType === 'SYSTEM') {
      return 2;
    }

    return 99;
  }

  /**
   * Converts a phase date-like value to a comparable timestamp.
   * @param dateValue Date-like phase start value.
   * @returns Unix timestamp, or negative infinity when unavailable/invalid.
   */
  private toTimestamp(
    dateValue: string | number | Date | null | undefined,
  ): number {
    if (dateValue === null || dateValue === undefined) {
      return Number.NEGATIVE_INFINITY;
    }

    if (dateValue instanceof Date) {
      return dateValue.getTime();
    }

    const timestamp = new Date(dateValue).getTime();
    return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
  }

  /**
   * Extracts normalized canonical phase identifier from phase payload.
   * @param phase Phase payload.
   * @returns Trimmed canonical phase ID when available, otherwise null.
   */
  private extractCanonicalPhaseId(
    phase?: ChallengePhaseResponse | null,
  ): string | null {
    const phaseId = (phase?.phaseId ?? phase?.id ?? '').trim();
    return phaseId.length > 0 ? phaseId : null;
  }

  /**
   * Extracts accepted identifiers from phase payload for backwards-compatible matching.
   * @param phase Phase payload.
   * @returns Unique identifiers including canonical `phaseId` and legacy `id`.
   */
  private extractPhaseIdentifiers(
    phase?: ChallengePhaseResponse | null,
  ): string[] {
    const phaseIds = [
      (phase?.phaseId ?? '').trim(),
      (phase?.id ?? '').trim(),
    ].filter((phaseId): phaseId is string => phaseId.length > 0);

    return [...new Set(phaseIds)];
  }

  /**
   * Normalizes challenge-api response variants to a challenge data object.
   * @param responseBody Raw challenge-api response body.
   * @returns Challenge payload that contains phases/currentPhase.
   */
  private resolveChallengePayload(
    responseBody: ChallengeResponse,
  ): ChallengeResponse {
    if (responseBody.result?.content) {
      return responseBody.result.content;
    }

    if (responseBody.result?.phases || responseBody.result?.currentPhase) {
      return responseBody.result;
    }

    return responseBody;
  }

  /**
   * Normalizes marathon match Kafka messages to direct submission payload.
   * @param message Raw parsed Kafka message.
   * @returns Submission payload consumed by scorer orchestration logic.
   */
  private resolveSubmissionPayload(
    message: MarathonMatchSubmissionKafkaMessage,
  ): MarathonMatchSubmissionEventPayload {
    if (this.isEventEnvelope(message)) {
      const emptyPayload: MarathonMatchSubmissionEventPayload = {
        submissionId: '',
        challengeId: '',
        submissionUrl: '',
        memberHandle: '',
        memberId: '',
        submittedDate: '',
      };
      return message.payload ?? emptyPayload;
    }

    return message;
  }

  /**
   * Detects event-bus envelopes that wrap submission data in `payload`.
   * @param message Parsed Kafka message.
   * @returns True when the message has an envelope structure.
   */
  private isEventEnvelope(
    message: MarathonMatchSubmissionKafkaMessage,
  ): message is MarathonMatchSubmissionEventEnvelope {
    return (
      typeof message === 'object' && message !== null && 'payload' in message
    );
  }

  /**
   * Coerces an unknown value into a plain record.
   * @param value Value to inspect.
   * @returns The input record, or an empty record for non-object values.
   */
  private asRecord(value: unknown): Record<string, unknown> {
    return this.isRecord(value) ? value : {};
  }

  /**
   * Checks whether an unknown value is a non-array object record.
   * @param value Value to inspect.
   * @returns True when the value is a plain object-like record.
   */
  private isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
  }

  /**
   * Builds a submission-api base URL without trailing slashes.
   * @param submissionApiUrl Configured submission-api-v6 base URL.
   * @returns Normalized base URL.
   */
  private buildSubmissionApiBaseUrl(submissionApiUrl: string): string {
    return submissionApiUrl.replace(/\/+$/, '');
  }

  /**
   * Normalizes example/provisional/system phase names.
   * @param testPhase Raw phase config or metadata value.
   * @returns Canonical phase name.
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
   * Parses boolean values from booleans, string booleans, and numeric flags.
   * @param value Value to inspect.
   * @returns Parsed boolean, or null when the value is not a recognized flag.
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
   * Extracts one submission object from direct and wrapped submission-api responses.
   * @param data Raw submission-api response body.
   * @returns Submission record when present.
   */
  private extractSubmissionRecord(
    data: unknown,
  ): Record<string, unknown> | undefined {
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
   * Trims an unknown value when it is a non-empty string.
   * @param value Value to inspect.
   * @returns Trimmed string, or undefined for non-string and blank values.
   */
  private asString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim().length > 0
      ? value.trim()
      : undefined;
  }
}
