import { Injectable } from '@nestjs/common';
import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
  Task,
} from '@aws-sdk/client-ecs';
import { LoggerService } from './logger.service';
import { M2MService } from './m2m.service';

interface MarathonMatchTaskConfig {
  taskDefinitionName: string;
  taskDefinitionVersion: string;
}

export interface MarathonMatchScoringPhase {
  configType: string;
  startSeed: number;
  numberOfTests: number;
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

  constructor(private readonly m2mService: M2MService) {
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
   * @returns ECS task ARN of the launched Fargate task.
   * Required env vars: ECS_CLUSTER, ECS_CONTAINER_NAME, ECS_SUBNETS, ECS_SECURITY_GROUPS,
   * AWS_REGION, MARATHON_MATCH_API_URL, REVIEW_TYPE_ID.
   * @throws Error when required ENV vars are missing, token fetch fails, or ECS launch fails.
   */
  async launchScorerTask(
    challengeId: string,
    submissionId: string,
    mmConfig: MarathonMatchTaskConfig,
    scoringPhase: MarathonMatchScoringPhase,
  ): Promise<string> {
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
                environment: [
                  { name: 'TESTER_CONFIG_ID', value: challengeId },
                  { name: 'SUBMISSION_ID', value: submissionId },
                  { name: 'ACCESS_TOKEN', value: token },
                  {
                    name: 'MARATHON_MATCH_API_URL',
                    value: marathonMatchApiUrl,
                  },
                  {
                    name: 'REVIEW_TYPE_ID',
                    value: reviewTypeId,
                  },
                  {
                    name: 'TEST_PHASE',
                    value: testPhase,
                  },
                  {
                    name: 'PHASE_CONFIG_TYPE',
                    value: scoringPhase.configType,
                  },
                  {
                    name: 'PHASE_START_SEED',
                    value: String(scoringPhase.startSeed),
                  },
                  {
                    name: 'PHASE_NUMBER_OF_TESTS',
                    value: String(scoringPhase.numberOfTests),
                  },
                ],
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

      this.logger.log({
        message: 'Launched ECS scorer task',
        challengeId,
        submissionId,
        taskDefinition,
        cluster,
        taskArn,
      });

      return taskArn;
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
}
