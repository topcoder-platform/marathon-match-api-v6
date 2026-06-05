import { Injectable } from '@nestjs/common';
import {
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  RunTaskCommand,
  Task,
} from '@aws-sdk/client-ecs';
import { PhaseConfigType } from '@prisma/client';
import { LoggerService } from './logger.service';
import { M2MService } from './m2m.service';
import { PrismaService } from './prisma.service';

interface MarathonMatchTaskConfig {
  taskDefinitionName: string;
  taskDefinitionVersion: string;
}

export interface MarathonMatchScoringPhase {
  configType: string;
  startSeed: bigint | string;
  numberOfTests: number;
}

export interface MarathonMatchScorerTaskLaunchResult {
  taskArn: string;
  taskId: string;
  cluster: string;
  containerName: string;
  taskDefinition: string;
  logGroup?: string;
  logStreamPrefix?: string;
  logStreamName?: string;
  cloudWatchLogsConsoleUrl?: string;
}

interface PersistSubmissionRunnerLogInput {
  challengeId: string;
  submissionId: string;
  scoringPhase: MarathonMatchScoringPhase;
  launchResult: MarathonMatchScorerTaskLaunchResult;
}

/**
 * Wraps AWS ECS Fargate task orchestration for the marathon match scoring
 * pipeline. This service is a globally provided singleton that can be injected
 * anywhere ECS task launching is required.
 */
@Injectable()
export class EcsService {
  private readonly logger = LoggerService.forRoot('EcsService');
  private readonly ecsClient: ECSClient;

  constructor(
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
  ) {
    this.ecsClient = new ECSClient({
      region: process.env.AWS_REGION || 'us-east-1',
    });
  }

  /**
   * Launches a scorer task in ECS Fargate for a marathon match submission.
   * @param challengeId Challenge ID used by the ECS runner to load config endpoints.
   * @param submissionId Submission ID passed to the ECS container.
   * @param mmConfig Task definition name and version from the marathonMatchConfig record.
   * @param scoringPhase Active phase settings used by the runner for flags and seed range.
   * @param reviewId Optional review-api review id that should be marked completed after callback processing.
   * @returns ECS task launch details with task/log mapping metadata.
   * Required env vars: ECS_CLUSTER, ECS_CONTAINER_NAME, ECS_SUBNETS, ECS_SECURITY_GROUPS,
   * AWS_REGION, MARATHON_MATCH_API_URL, REVIEW_TYPE_ID.
   * @throws Error when required ENV vars are missing, token fetch fails, or ECS launch fails.
   */
  async launchScorerTask(
    challengeId: string,
    submissionId: string,
    mmConfig: MarathonMatchTaskConfig,
    scoringPhase: MarathonMatchScoringPhase,
    reviewId?: string,
  ): Promise<MarathonMatchScorerTaskLaunchResult> {
    const cluster = this.getRequiredEnv('ECS_CLUSTER');
    const containerName = this.getRequiredEnv('ECS_CONTAINER_NAME');
    const subnets = this.getRequiredCsvEnv('ECS_SUBNETS');
    const securityGroups = this.getRequiredCsvEnv('ECS_SECURITY_GROUPS');
    const marathonMatchApiUrl = this.getRequiredEnv('MARATHON_MATCH_API_URL');
    const reviewTypeId = this.getRequiredEnv('REVIEW_TYPE_ID');
    const taskDefinitionName = mmConfig.taskDefinitionName?.trim();
    const taskDefinitionVersion = mmConfig.taskDefinitionVersion?.trim();
    const testPhase = this.mapConfigTypeToTestPhase(scoringPhase.configType);

    if (!taskDefinitionName) {
      throw new Error('Missing required task definition name in mmConfig.');
    }

    if (!taskDefinitionVersion) {
      throw new Error('Missing required task definition version in mmConfig.');
    }

    let token: string;
    try {
      token = await this.m2mService.getM2MToken();
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to get M2M token for ECS task launch: ${errorMessage}`,
      );
    }

    if (!token) {
      throw new Error('Failed to get M2M token for ECS task launch.');
    }

    const taskDefinition = `${taskDefinitionName}:${taskDefinitionVersion}`;
    const runnerEnvironment = [
      { name: 'TESTER_CONFIG_ID', value: challengeId },
      { name: 'SUBMISSION_ID', value: submissionId },
      { name: 'ACCESS_TOKEN', value: token },
      { name: 'MARATHON_MATCH_API_URL', value: marathonMatchApiUrl },
      { name: 'REVIEW_TYPE_ID', value: reviewTypeId },
      { name: 'TEST_PHASE', value: testPhase },
      { name: 'PHASE_CONFIG_TYPE', value: scoringPhase.configType },
      { name: 'PHASE_START_SEED', value: String(scoringPhase.startSeed) },
      {
        name: 'PHASE_NUMBER_OF_TESTS',
        value: String(scoringPhase.numberOfTests),
      },
    ];

    if (reviewId?.trim()) {
      runnerEnvironment.push({ name: 'REVIEW_ID', value: reviewId.trim() });
    }

    this.appendOptionalEnvOverride(runnerEnvironment, 'DEBUG_LOG_ACCESS_TOKEN');
    this.appendOptionalEnvOverride(
      runnerEnvironment,
      'DEBUG_LOG_FULL_ACCESS_TOKEN',
    );
    this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_URL');
    this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_AUDIENCE');
    this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_PROXY_SERVER_URL');
    this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_CLIENT_ID');
    this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_CLIENT_SECRET');

    try {
      const response = await this.ecsClient.send(
        new RunTaskCommand({
          cluster,
          taskDefinition,
          launchType: 'FARGATE',
          networkConfiguration: {
            awsvpcConfiguration: {
              subnets,
              securityGroups,
              assignPublicIp: 'DISABLED',
            },
          },
          overrides: {
            containerOverrides: [
              {
                name: containerName,
                environment: runnerEnvironment,
              },
            ],
          },
        }),
      );

      if (!response.tasks || response.tasks.length === 0) {
        throw new Error(
          'ECS RunTask returned no tasks for marathon match scorer launch.',
        );
      }

      const taskArn = response.tasks[0]?.taskArn;
      if (!taskArn) {
        throw new Error(
          'ECS RunTask returned a task without taskArn for marathon match scorer launch.',
        );
      }

      const taskId = this.extractTaskId(taskArn);
      const logConfiguration = await this.resolveAwsLogsConfiguration(
        taskDefinition,
        containerName,
      );
      const logGroup = logConfiguration.logGroup;
      const logStreamPrefix = logConfiguration.logStreamPrefix;
      const logStreamName = this.buildAwsLogsStreamName(
        logStreamPrefix,
        containerName,
        taskId,
      );
      const cloudWatchLogsConsoleUrl = this.buildCloudWatchLogsConsoleUrl(
        logGroup,
        logStreamName,
      );

      const launchResult: MarathonMatchScorerTaskLaunchResult = {
        taskArn,
        taskId,
        cluster,
        containerName,
        taskDefinition,
        logGroup,
        logStreamPrefix,
        logStreamName,
        cloudWatchLogsConsoleUrl,
      };

      this.logger.log({
        message: 'Launched ECS scorer task',
        challengeId,
        submissionId,
        taskDefinition,
        cluster,
        taskArn,
        taskId,
        logGroup: logGroup ?? null,
        logStreamPrefix: logStreamPrefix ?? null,
        logStreamName: logStreamName ?? null,
        cloudWatchLogsConsoleUrl: cloudWatchLogsConsoleUrl ?? null,
      });

      this.logger.log({
        message: 'Submission to ECS runner log mapping',
        submissionId,
        challengeId,
        taskArn,
        taskId,
        cluster,
        containerName,
        logGroup: logGroup ?? null,
        logStreamPrefix: logStreamPrefix ?? null,
        logStreamName: logStreamName ?? null,
        cloudWatchLogsConsoleUrl: cloudWatchLogsConsoleUrl ?? null,
      });

      await this.persistSubmissionRunnerLogMapping({
        challengeId,
        submissionId,
        scoringPhase,
        launchResult,
      });

      return launchResult;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to launch ECS scorer task for submission ${submissionId}: ${errorMessage}`,
      );
    }
  }

  /**
   * Fetches the latest ECS task metadata for a previously launched scorer task.
   * @param taskArn Task ARN to describe.
   * @param clusterName Optional ECS cluster override. Defaults to ECS_CLUSTER env var.
   * @returns ECS task details including last/desired status and container metadata.
   * @throws Error when task ARN is missing or ECS describe fails/returns no task.
   */
  async describeTask(taskArn: string, clusterName?: string): Promise<Task> {
    const normalizedTaskArn = taskArn?.trim();
    if (!normalizedTaskArn) {
      throw new Error('Task ARN is required to describe an ECS task.');
    }

    const cluster = clusterName?.trim() || this.getRequiredEnv('ECS_CLUSTER');

    try {
      const response = await this.ecsClient.send(
        new DescribeTasksCommand({
          cluster,
          tasks: [normalizedTaskArn],
        }),
      );

      if (!response.tasks || response.tasks.length === 0) {
        const failureMessage = response.failures
          ?.map((failure) =>
            [failure.arn, failure.reason].filter(Boolean).join(': '),
          )
          .join('; ');

        throw new Error(
          failureMessage
            ? `ECS DescribeTasks returned no tasks. Failures: ${failureMessage}`
            : `ECS DescribeTasks returned no tasks for taskArn ${normalizedTaskArn}.`,
        );
      }

      const task = response.tasks[0];
      if (!task?.taskArn) {
        throw new Error(
          `ECS DescribeTasks returned invalid task data for taskArn ${normalizedTaskArn}.`,
        );
      }

      this.logger.log({
        message: 'Described ECS scorer task',
        cluster,
        taskArn: task.taskArn,
        lastStatus: task.lastStatus,
        desiredStatus: task.desiredStatus,
      });

      return task;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to describe ECS task ${normalizedTaskArn}: ${errorMessage}`,
      );
    }
  }

  private getRequiredEnv(envName: string): string {
    const value = process.env[envName]?.trim();
    if (!value) {
      throw new Error(`Missing required environment variable: ${envName}`);
    }
    return value;
  }

  private getRequiredCsvEnv(envName: string): string[] {
    const value = this.getRequiredEnv(envName);
    const values = value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);

    if (values.length === 0) {
      throw new Error(
        `Environment variable ${envName} must contain at least one value.`,
      );
    }

    return values;
  }

  /**
   * Adds a process env var to ECS container overrides only when set.
   * @param environment Mutable ECS env override list.
   * @param envName Environment variable to pass through.
   */
  private appendOptionalEnvOverride(
    environment: Array<{ name: string; value: string }>,
    envName: string,
  ): void {
    const value = process.env[envName]?.trim();
    if (!value) {
      return;
    }
    environment.push({ name: envName, value });
  }

  private mapConfigTypeToTestPhase(configType: string): string {
    const normalizedConfigType = configType?.trim().toUpperCase();
    if (normalizedConfigType === 'EXAMPLE') {
      return 'example';
    }
    if (normalizedConfigType === 'SYSTEM') {
      return 'system';
    }
    if (normalizedConfigType === 'PROVISIONAL') {
      return 'provisional';
    }

    throw new Error(
      `Unsupported phase config type '${configType}' for ECS runner launch.`,
    );
  }

  /**
   * Extracts the task ID suffix from a full ECS task ARN.
   * @param taskArn ECS task ARN.
   * @returns Parsed task ID.
   */
  private extractTaskId(taskArn: string): string {
    const arn = taskArn.trim();
    const slashIndex = arn.lastIndexOf('/');
    if (slashIndex < 0 || slashIndex + 1 >= arn.length) {
      return arn;
    }

    return arn.slice(slashIndex + 1);
  }

  /**
   * Attempts to resolve awslogs configuration from task definition container config.
   * @param taskDefinition ECS task definition name:revision.
   * @param containerName Container name to inspect.
   * @returns awslogs group/prefix metadata when configured.
   */
  private async resolveAwsLogsConfiguration(
    taskDefinition: string,
    containerName: string,
  ): Promise<{ logGroup?: string; logStreamPrefix?: string }> {
    try {
      const response = await this.ecsClient.send(
        new DescribeTaskDefinitionCommand({
          taskDefinition,
        }),
      );

      const containerDefinition =
        response.taskDefinition?.containerDefinitions?.find(
          (definition) => definition.name === containerName,
        );
      const awsLogsGroup =
        containerDefinition?.logConfiguration?.options?.[
          'awslogs-group'
        ]?.trim();
      const awsLogsStreamPrefix =
        containerDefinition?.logConfiguration?.options?.[
          'awslogs-stream-prefix'
        ]?.trim();

      return {
        logGroup: awsLogsGroup || undefined,
        logStreamPrefix: awsLogsStreamPrefix || undefined,
      };
    } catch (error) {
      this.logger.warn({
        message: 'Unable to resolve ECS task definition awslogs configuration',
        taskDefinition,
        containerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return {};
    }
  }

  /**
   * Builds awslogs stream name from task definition prefix + container + task id.
   * @param logStreamPrefix awslogs stream prefix configured in task definition.
   * @param containerName ECS container name.
   * @param taskId Task ID suffix parsed from task ARN.
   * @returns Deterministic CloudWatch log stream name when prefix exists.
   */
  private buildAwsLogsStreamName(
    logStreamPrefix: string | undefined,
    containerName: string,
    taskId: string,
  ): string | undefined {
    const normalizedPrefix = logStreamPrefix?.trim();
    const normalizedContainerName = containerName?.trim();
    const normalizedTaskId = taskId?.trim();
    if (!normalizedPrefix || !normalizedContainerName || !normalizedTaskId) {
      return undefined;
    }

    return `${normalizedPrefix}/${normalizedContainerName}/${normalizedTaskId}`;
  }

  /**
   * Builds a CloudWatch logs console URL for a specific log group/stream pair.
   * @param logGroup CloudWatch log group.
   * @param logStreamName CloudWatch log stream name.
   * @returns Deep link URL when both values are available.
   */
  private buildCloudWatchLogsConsoleUrl(
    logGroup?: string,
    logStreamName?: string,
  ): string | undefined {
    if (!logGroup || !logStreamName) {
      return undefined;
    }

    const region = process.env.AWS_REGION?.trim() || 'us-east-1';
    return `https://${region}.console.aws.amazon.com/cloudwatch/home?region=${encodeURIComponent(region)}#logsV2:log-groups/log-group/${encodeURIComponent(logGroup)}/log-events/${encodeURIComponent(logStreamName)}`;
  }

  /**
   * Persists submission-to-runner-log mapping for later retrieval APIs.
   * @param input Mapping payload derived from the task launch.
   */
  private async persistSubmissionRunnerLogMapping(
    input: PersistSubmissionRunnerLogInput,
  ): Promise<void> {
    const phaseConfigType = this.normalizePhaseConfigType(
      input.scoringPhase.configType,
    );
    const launchResult = input.launchResult;

    try {
      await this.prisma.submissionRunnerLog.upsert({
        where: { taskArn: launchResult.taskArn },
        create: {
          submissionId: input.submissionId,
          challengeId: input.challengeId,
          taskArn: launchResult.taskArn,
          taskId: launchResult.taskId,
          cluster: launchResult.cluster,
          containerName: launchResult.containerName,
          taskDefinition: launchResult.taskDefinition,
          phaseConfigType,
          logGroup: launchResult.logGroup,
          logStreamPrefix: launchResult.logStreamPrefix,
          logStreamName: launchResult.logStreamName,
          cloudWatchLogsConsoleUrl: launchResult.cloudWatchLogsConsoleUrl,
        },
        update: {
          submissionId: input.submissionId,
          challengeId: input.challengeId,
          taskId: launchResult.taskId,
          cluster: launchResult.cluster,
          containerName: launchResult.containerName,
          taskDefinition: launchResult.taskDefinition,
          phaseConfigType,
          logGroup: launchResult.logGroup,
          logStreamPrefix: launchResult.logStreamPrefix,
          logStreamName: launchResult.logStreamName,
          cloudWatchLogsConsoleUrl: launchResult.cloudWatchLogsConsoleUrl,
        },
      });

      this.logger.log({
        message: 'Persisted submission runner log mapping',
        submissionId: input.submissionId,
        challengeId: input.challengeId,
        taskArn: launchResult.taskArn,
      });
    } catch (error) {
      this.logger.error({
        message: 'Failed to persist submission runner log mapping',
        submissionId: input.submissionId,
        challengeId: input.challengeId,
        taskArn: launchResult.taskArn,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Normalizes string config type to Prisma enum.
   * @param configType Raw config type from marathon match phase config.
   * @returns Prisma enum value.
   */
  private normalizePhaseConfigType(configType: string): PhaseConfigType {
    const normalized = configType?.trim().toUpperCase();
    if (normalized === PhaseConfigType.EXAMPLE) {
      return PhaseConfigType.EXAMPLE;
    }
    if (normalized === PhaseConfigType.SYSTEM) {
      return PhaseConfigType.SYSTEM;
    }
    if (normalized === PhaseConfigType.PROVISIONAL) {
      return PhaseConfigType.PROVISIONAL;
    }

    throw new Error(`Unsupported phase config type '${configType}'.`);
  }
}
