import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  OutputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { Injectable, NotFoundException } from '@nestjs/common';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export interface GetSubmissionRunnerLogsOptions {
  taskArn?: string;
  nextToken?: string;
  limit?: number;
  startFromHead?: boolean;
}

export interface SubmissionRunnerLogMapping {
  id: string;
  submissionId: string;
  challengeId: string;
  taskArn: string;
  taskId: string;
  cluster: string;
  containerName: string;
  taskDefinition: string;
  phaseConfigType?: string;
  logGroup?: string;
  logStreamPrefix?: string;
  logStreamName?: string;
  cloudWatchLogsConsoleUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SubmissionRunnerLogsResponse {
  submissionId: string;
  selectedTaskArn: string;
  selectedMapping: SubmissionRunnerLogMapping;
  mappings: SubmissionRunnerLogMapping[];
  events: OutputLogEvent[];
  nextForwardToken?: string;
  nextBackwardToken?: string;
  warning?: string;
}

interface SubmissionRunnerLogRecord {
  id: string;
  submissionId: string;
  challengeId: string;
  taskArn: string;
  taskId: string;
  cluster: string;
  containerName: string;
  taskDefinition: string;
  phaseConfigType: string | null;
  logGroup: string | null;
  logStreamPrefix: string | null;
  logStreamName: string | null;
  cloudWatchLogsConsoleUrl: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Retrieves persisted ECS runner task/log mappings and reads CloudWatch log
 * events for a submission.
 */
@Injectable()
export class SubmissionRunnerLogService {
  private readonly logger = LoggerService.forRoot('SubmissionRunnerLogService');
  private readonly cloudWatchLogsClient: CloudWatchLogsClient;

  constructor(private readonly prisma: PrismaService) {
    this.cloudWatchLogsClient = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  /**
   * Fetches CloudWatch log events for a submission using persisted mapping rows.
   * @param submissionId Submission ID to look up.
   * @param options Optional paging/task selection options.
   * @returns Mapping metadata and fetched log events.
   * @throws NotFoundException when mapping rows do not exist for the submission.
   */
  async getLogsForSubmission(
    submissionId: string,
    options: GetSubmissionRunnerLogsOptions,
  ): Promise<SubmissionRunnerLogsResponse> {
    const normalizedSubmissionId = submissionId?.trim();
    if (!normalizedSubmissionId) {
      throw new NotFoundException('submissionId is required.');
    }

    const mappings = await this.prisma.submissionRunnerLog.findMany({
      where: { submissionId: normalizedSubmissionId },
      orderBy: [{ createdAt: 'desc' }],
    });

    if (!mappings.length) {
      throw new NotFoundException(
        `No ECS runner log mapping found for submission ${normalizedSubmissionId}.`,
      );
    }

    const normalizedTaskArn = options.taskArn?.trim();
    const selectedMappingRecord = normalizedTaskArn
      ? mappings.find((mapping) => mapping.taskArn === normalizedTaskArn)
      : mappings[0];

    if (!selectedMappingRecord) {
      throw new NotFoundException(
        `No ECS runner log mapping found for submission ${normalizedSubmissionId} with taskArn ${normalizedTaskArn}.`,
      );
    }

    const selectedMapping = this.toMapping(selectedMappingRecord);
    const allMappings = mappings.map((mapping) => this.toMapping(mapping));
    const normalizedLimit = this.normalizeLimit(options.limit);

    if (
      !selectedMappingRecord.logGroup ||
      !selectedMappingRecord.logStreamName
    ) {
      return {
        submissionId: normalizedSubmissionId,
        selectedTaskArn: selectedMapping.taskArn,
        selectedMapping,
        mappings: allMappings,
        events: [],
        warning:
          'Selected mapping does not yet include logGroup/logStreamName values.',
      };
    }

    try {
      const response = await this.cloudWatchLogsClient.send(
        new GetLogEventsCommand({
          logGroupName: selectedMappingRecord.logGroup,
          logStreamName: selectedMappingRecord.logStreamName,
          nextToken: options.nextToken?.trim() || undefined,
          startFromHead: options.startFromHead ?? false,
          limit: normalizedLimit,
        }),
      );

      return {
        submissionId: normalizedSubmissionId,
        selectedTaskArn: selectedMapping.taskArn,
        selectedMapping,
        mappings: allMappings,
        events: response.events || [],
        nextForwardToken: response.nextForwardToken,
        nextBackwardToken: response.nextBackwardToken,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);

      this.logger.error({
        message: 'Failed to fetch CloudWatch log events for submission',
        submissionId: normalizedSubmissionId,
        taskArn: selectedMapping.taskArn,
        logGroup: selectedMappingRecord.logGroup,
        logStreamName: selectedMappingRecord.logStreamName,
        error: errorMessage,
      });

      throw new Error(
        `Failed to retrieve CloudWatch logs for submission ${normalizedSubmissionId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Clamps CloudWatch `GetLogEvents` page size to a safe range.
   * @param limit Requested limit.
   * @returns Safe limit (1..10000), defaulting to 200.
   */
  private normalizeLimit(limit?: number): number {
    if (!Number.isFinite(limit)) {
      return 200;
    }

    const rounded = Math.floor(limit as number);
    if (rounded < 1) {
      return 1;
    }
    if (rounded > 10000) {
      return 10000;
    }

    return rounded;
  }

  /**
   * Maps Prisma row to API response mapping object.
   * @param record Prisma row.
   * @returns Serializable mapping object.
   */
  private toMapping(
    record: SubmissionRunnerLogRecord,
  ): SubmissionRunnerLogMapping {
    return {
      id: record.id,
      submissionId: record.submissionId,
      challengeId: record.challengeId,
      taskArn: record.taskArn,
      taskId: record.taskId,
      cluster: record.cluster,
      containerName: record.containerName,
      taskDefinition: record.taskDefinition,
      phaseConfigType: record.phaseConfigType || undefined,
      logGroup: record.logGroup || undefined,
      logStreamPrefix: record.logStreamPrefix || undefined,
      logStreamName: record.logStreamName || undefined,
      cloudWatchLogsConsoleUrl: record.cloudWatchLogsConsoleUrl || undefined,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }
}
