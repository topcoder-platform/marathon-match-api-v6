import { HttpService } from '@nestjs/axios';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompilationStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
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
        this.logger.log(
          `Marathon match config ${config.id} is inactive. Skipping submission ${submissionId}.`,
        );
        return;
      }

      const openPhaseIds = await this.getOpenPhaseIds(challengeId);
      if (openPhaseIds.length === 0) {
        this.logger.log(
          `Challenge ${challengeId} has no open phase. Skipping submission ${submissionId}.`,
        );
        return;
      }

      const matchingPhaseConfig = this.findMatchingPhaseConfig(
        config.phaseConfigs,
        openPhaseIds,
      );
      if (!matchingPhaseConfig) {
        this.logger.log({
          message:
            'No configured marathon match phase for open challenge phases',
          challengeId,
          submissionId,
          openPhaseIds,
        });
        return;
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        throw new Error(
          `Tester ${config.testerId} for config ${config.id} is not ready. Current compilation status: ${config.tester.compilationStatus}.`,
        );
      }

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
      );
      this.logSubmissionRunnerMapping(challengeId, submissionId, launchResult);

      this.logger.log({
        message: 'Marathon match submission event processed successfully',
        challengeId,
        submissionId,
        openPhaseIds,
        matchedPhaseId: matchingPhaseConfig.phaseId,
        matchedPhaseConfigId: matchingPhaseConfig.id,
        taskArn: launchResult.taskArn,
        taskId: launchResult.taskId,
        logGroup: launchResult.logGroup ?? null,
        logStreamPrefix: launchResult.logStreamPrefix ?? null,
        logStreamName: launchResult.logStreamName ?? null,
        cloudWatchLogsConsoleUrl: launchResult.cloudWatchLogsConsoleUrl ?? null,
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
   * Calls challenge-api-v6 and returns currently open phase IDs.
   * @param challengeId Challenge identifier to fetch.
   * @returns Ordered open phase IDs. Falls back to currentPhase when needed.
   * @throws Error When token retrieval or HTTP request fails.
   */
  private async getOpenPhaseIds(challengeId: string): Promise<string[]> {
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

    return this.extractOpenPhaseIds(response.data);
  }

  /**
   * Extracts ordered open phase IDs from challenge-api response payload.
   * @param responseBody HTTP response body from challenge-api.
   * @returns Ordered open phase IDs, or a currentPhase fallback ID.
   */
  private extractOpenPhaseIds(responseBody: ChallengeResponse): string[] {
    const challengeData = this.resolveChallengePayload(responseBody);
    const openPhaseIds = this.resolveOpenPhaseIds(challengeData.phases);
    if (openPhaseIds.length > 0) {
      return openPhaseIds;
    }

    const currentPhaseId = this.extractPhaseId(challengeData.currentPhase);
    return currentPhaseId ? [currentPhaseId] : [];
  }

  /**
   * Resolves open phase IDs ordered by latest start, then timeline order.
   * @param phases Challenge phases.
   * @returns Ordered open phase IDs.
   */
  private resolveOpenPhaseIds(phases?: ChallengePhaseResponse[]): string[] {
    if (!Array.isArray(phases) || phases.length === 0) {
      return [];
    }

    const openPhases = phases
      .map((phase, index) => ({ phase, index }))
      .filter(({ phase }) => phase?.isOpen === true);
    if (openPhases.length === 0) {
      return [];
    }

    const orderedPhaseIds = openPhases
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
      .map(({ phase }) => this.extractPhaseId(phase))
      .filter((phaseId): phaseId is string => Boolean(phaseId));

    return [...new Set(orderedPhaseIds)];
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
    launchResult: MarathonMatchScorerTaskLaunchResult,
  ): void {
    this.logger.log({
      message: 'Submission runner log mapping ready',
      challengeId,
      submissionId,
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
   * Finds a configured phase mapping for the highest-priority open challenge phase.
   * @param phaseConfigs Stored phase configuration rows for a challenge.
   * @param openPhaseIds Open challenge phase IDs ordered by priority.
   * @returns Matching phase config or null when no mapping exists.
   */
  private findMatchingPhaseConfig<TPhaseConfig extends { phaseId: string }>(
    phaseConfigs: TPhaseConfig[],
    openPhaseIds: string[],
  ): TPhaseConfig | null {
    for (const openPhaseId of openPhaseIds) {
      const matchingPhaseConfig = phaseConfigs.find(
        (phaseConfig) => phaseConfig.phaseId === openPhaseId,
      );
      if (matchingPhaseConfig) {
        return matchingPhaseConfig;
      }
    }

    return null;
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
   * Extracts normalized phase identifier from phase payload.
   * @param phase Phase payload.
   * @returns Trimmed phase ID when available, otherwise null.
   */
  private extractPhaseId(phase?: ChallengePhaseResponse | null): string | null {
    const phaseId = (phase?.phaseId ?? phase?.id ?? '').trim();
    return phaseId.length > 0 ? phaseId : null;
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
}
