import { HttpService } from '@nestjs/axios';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { CompilationStatus } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import { EcsService } from 'src/shared/modules/global/ecs.service';
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

      const activePhaseId = await this.getActivePhaseId(challengeId);
      if (!activePhaseId) {
        this.logger.log(
          `Challenge ${challengeId} has no active phase. Skipping submission ${submissionId}.`,
        );
        return;
      }

      const matchingPhaseConfig = config.phaseConfigs.find(
        (phaseConfig) => phaseConfig.phaseId === activePhaseId,
      );
      if (!matchingPhaseConfig) {
        this.logger.log({
          message:
            'No configured marathon match phase for active challenge phase',
          challengeId,
          submissionId,
          activePhaseId,
        });
        return;
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        throw new Error(
          `Tester ${config.testerId} for config ${config.id} is not ready. Current compilation status: ${config.tester.compilationStatus}.`,
        );
      }

      const taskArn = await this.ecsService.launchScorerTask(
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

      this.logger.log({
        message: 'Marathon match submission event processed successfully',
        challengeId,
        submissionId,
        activePhaseId,
        matchedPhaseConfigId: matchingPhaseConfig.id,
        taskArn,
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
   * Calls challenge-api-v6 and returns the ID of the active phase.
   * @param challengeId Challenge identifier to fetch.
   * @returns Active phase ID or null when not present.
   * @throws Error When token retrieval or HTTP request fails.
   */
  private async getActivePhaseId(challengeId: string): Promise<string | null> {
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

    return this.extractActivePhaseId(response.data);
  }

  /**
   * Extracts active phase ID from challenge-api response payload.
   * @param responseBody HTTP response body from challenge-api.
   * @returns Active phase ID when found, otherwise null.
   */
  private extractActivePhaseId(responseBody: ChallengeResponse): string | null {
    const challengeData = this.resolveChallengePayload(responseBody);
    if (challengeData.currentPhase) {
      const currentPhaseId = this.extractPhaseId(challengeData.currentPhase);
      if (currentPhaseId) {
        return currentPhaseId;
      }
    }

    const activePhase = this.resolveLatestStartedOpenPhase(
      challengeData.phases,
    );
    return this.extractPhaseId(activePhase);
  }

  /**
   * Selects the latest-started open phase using actual/scheduled start timestamps.
   * @param phases Challenge phases.
   * @returns Latest-started open phase or null when no open phase exists.
   */
  private resolveLatestStartedOpenPhase(
    phases?: ChallengePhaseResponse[],
  ): ChallengePhaseResponse | null {
    if (!Array.isArray(phases) || phases.length === 0) {
      return null;
    }

    const openPhases = phases.filter((phase) => phase?.isOpen === true);
    if (openPhases.length === 0) {
      return null;
    }

    return openPhases.reduce((latestOpenPhase, phase) => {
      const latestStartTimestamp = this.toTimestamp(
        latestOpenPhase.actualStartDate ?? latestOpenPhase.scheduledStartDate,
      );
      const phaseStartTimestamp = this.toTimestamp(
        phase.actualStartDate ?? phase.scheduledStartDate,
      );

      if (phaseStartTimestamp > latestStartTimestamp) {
        return phase;
      }

      if (phaseStartTimestamp === latestStartTimestamp) {
        const latestPhaseId = this.extractPhaseId(latestOpenPhase) ?? '';
        const phaseId = this.extractPhaseId(phase) ?? '';
        if (phaseId > latestPhaseId) {
          return phase;
        }
      }

      return latestOpenPhase;
    });
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
