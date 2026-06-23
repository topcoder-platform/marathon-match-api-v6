import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
  OutputLogEvent,
} from '@aws-sdk/client-cloudwatch-logs';
import { HttpService } from '@nestjs/axios';
import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { resolveSubmissionApiBaseUrl } from 'src/shared/config/submission-api-url.config';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export interface GetSubmissionRunnerLogsOptions {
  taskArn?: string;
  nextToken?: string;
  limit?: number;
  startFromHead?: boolean;
  authorizedChallengeId?: string;
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

  constructor(
    private readonly httpService: HttpService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
  ) {
    this.cloudWatchLogsClient = new CloudWatchLogsClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  /**
   * Fetches CloudWatch log events for a submission using persisted mapping rows.
   * @param submissionId Submission ID to look up.
   * @param options Optional paging/task selection and challenge scope options.
   * @param user Authenticated caller; non-privileged users must own the submission.
   * @returns Mapping metadata and fetched log events.
   * @throws NotFoundException when mapping rows do not exist for the submission.
   * @throws ForbiddenException when the caller is not allowed to read the submission logs.
   */
  async getLogsForSubmission(
    submissionId: string,
    options: GetSubmissionRunnerLogsOptions,
    user: JwtUser,
  ): Promise<SubmissionRunnerLogsResponse> {
    const normalizedSubmissionId = submissionId?.trim();
    if (!normalizedSubmissionId) {
      throw new NotFoundException('submissionId is required.');
    }

    const normalizedChallengeId = options.authorizedChallengeId?.trim();
    const canReadAnySubmission = this.hasPrivilegedRunnerLogRole(
      user,
      Boolean(normalizedChallengeId),
    );
    if (!canReadAnySubmission && user?.isMachine) {
      throw new ForbiddenException(
        'Only submission owners or privileged user roles can read runner logs.',
      );
    }

    const mappings = await this.prisma.submissionRunnerLog.findMany({
      where: {
        submissionId: normalizedSubmissionId,
        ...(normalizedChallengeId
          ? { challengeId: normalizedChallengeId }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
    });

    if (!mappings.length) {
      throw new NotFoundException(
        normalizedChallengeId
          ? `No ECS runner log mapping found for submission ${normalizedSubmissionId} in authorized challenge ${normalizedChallengeId}.`
          : `No ECS runner log mapping found for submission ${normalizedSubmissionId}.`,
      );
    }

    if (!canReadAnySubmission) {
      await this.assertSubmissionOwner(
        normalizedSubmissionId,
        mappings[0].challengeId,
        user,
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
   * Checks whether the caller can bypass submission ownership checks.
   * @param user Authenticated caller.
   * @param hasAuthorizedChallengeScope True when the runner-log guard already verified a challenge resource assignment.
   * @returns True for administrators, or for Copilot/Manager users constrained to an authorized challenge.
   */
  private hasPrivilegedRunnerLogRole(
    user: JwtUser,
    hasAuthorizedChallengeScope: boolean,
  ): boolean {
    if (!user || !Array.isArray(user.roles)) {
      return false;
    }

    const normalizedRoles = user.roles.map((role) =>
      this.normalizeIdentity(role),
    );

    if (normalizedRoles.includes(this.normalizeIdentity(UserRole.Admin))) {
      return true;
    }

    if (!hasAuthorizedChallengeScope) {
      return false;
    }

    const challengeScopedRoles = new Set(
      [UserRole.Copilot, UserRole.ProjectManager].map((role) =>
        this.normalizeIdentity(role),
      ),
    );

    return normalizedRoles.some((role) => challengeScopedRoles.has(role));
  }

  /**
   * Verifies that a non-privileged caller owns the requested submission.
   * @param submissionId Submission ID from the route.
   * @param challengeId Challenge ID from the persisted runner-log mapping.
   * @param user Authenticated caller.
   * @throws ForbiddenException when the caller cannot be matched to the submission owner.
   */
  private async assertSubmissionOwner(
    submissionId: string,
    challengeId: string,
    user: JwtUser,
  ): Promise<void> {
    if (!this.hasCallerIdentity(user)) {
      throw new ForbiddenException(
        'Authenticated user id or handle is required to read runner logs.',
      );
    }

    const submission = await this.fetchSubmissionForOwnership(
      submissionId,
      challengeId,
    );

    if (!submission || !this.isSubmissionOwner(submission, user)) {
      throw new ForbiddenException(
        'Only submission owners or privileged user roles can read runner logs.',
      );
    }
  }

  /**
   * Fetches the submission record with an M2M token so ownership is checked
   * against authoritative submission-api data rather than caller-supplied input.
   * @param submissionId Submission ID to fetch.
   * @param challengeId Challenge ID used to resolve the configured submission API URL.
   * @returns Submission record, or undefined when ownership cannot be verified.
   */
  private async fetchSubmissionForOwnership(
    submissionId: string,
    challengeId: string,
  ): Promise<Record<string, unknown> | undefined> {
    try {
      const token = await this.m2mService.getM2MToken();
      if (!token) {
        return undefined;
      }

      const submissionApiUrl = await this.resolveSubmissionApiUrl(challengeId);
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
    } catch (error) {
      this.logger.warn({
        message: 'Unable to verify runner log submission ownership',
        submissionId,
        challengeId,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * Resolves the submission-api base URL from the Marathon Match config.
   * @param challengeId Challenge ID associated with the runner-log mapping.
   * @returns Configured submission API URL, falling back to the default v6 API.
   */
  private async resolveSubmissionApiUrl(challengeId: string): Promise<string> {
    const config = await this.prisma.marathonMatchConfig.findUnique({
      where: { challengeId },
      select: { submissionApiUrl: true },
    });

    return resolveSubmissionApiBaseUrl({
      configuredUrl: config?.submissionApiUrl,
      fallbackApiBaseUrl: process.env.CHALLENGE_API_URL,
      environmentUrls: [
        process.env.CHALLENGE_API_URL,
        process.env.MARATHON_MATCH_API_URL,
        process.env.REVIEW_API_URL,
      ],
    });
  }

  /**
   * Checks whether the authenticated caller matches known submission owner fields.
   * @param submission Submission record returned by submission-api-v6.
   * @param user Authenticated caller.
   * @returns True when user ID/member ID or handle matches.
   */
  private isSubmissionOwner(
    submission: Record<string, unknown>,
    user: JwtUser,
  ): boolean {
    const callerUserId = this.normalizeIdentity(user.userId);
    const callerHandle = this.normalizeIdentity(user.handle);
    const member = this.asRecord(submission.member);
    const submitter = this.asRecord(submission.submitter);

    const ownerIds = [
      submission.userId,
      submission.memberId,
      member.userId,
      member.id,
      submitter.userId,
      submitter.id,
    ]
      .map((value) => this.normalizeIdentity(value))
      .filter((value): value is string => Boolean(value));

    const ownerHandles = [
      submission.memberHandle,
      submission.handle,
      member.handle,
      submitter.handle,
    ]
      .map((value) => this.normalizeIdentity(value))
      .filter((value): value is string => Boolean(value));

    return Boolean(
      (callerUserId && ownerIds.includes(callerUserId)) ||
      (callerHandle && ownerHandles.includes(callerHandle)),
    );
  }

  /**
   * Checks whether a caller has any stable identity field for ownership matching.
   * @param user Authenticated caller.
   * @returns True when userId or handle is present.
   */
  private hasCallerIdentity(user?: JwtUser): boolean {
    return Boolean(
      this.normalizeIdentity(user?.userId) ||
      this.normalizeIdentity(user?.handle),
    );
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
   * Extracts one submission object from direct and wrapped submission-api responses.
   * @param data Response body returned by submission-api-v6.
   * @returns Submission record when one can be found.
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
   * Extracts submission arrays from direct-list and wrapped API responses.
   * @param data Response body returned by submission-api-v6.
   * @returns Normalized submission records.
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
   * Safely clones record-like values and rejects arrays.
   * @param value Unknown value to normalize.
   * @returns Plain record or an empty object.
   */
  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return { ...(value as Record<string, unknown>) };
  }

  /**
   * Normalizes IDs, handles, and roles for stable comparisons.
   * @param value Unknown string-like value.
   * @returns Lower-case trimmed string, or an empty string.
   */
  private normalizeIdentity(value: unknown): string {
    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint'
    ) {
      return '';
    }

    return `${value}`.trim().toLowerCase();
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
