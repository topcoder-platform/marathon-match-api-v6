import { Injectable } from '@nestjs/common';
import {
  DescribeTasksCommand,
  DescribeTaskDefinitionCommand,
  ECSClient,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
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
  reusedExistingTask?: boolean;
  logGroup?: string;
  logStreamPrefix?: string;
  logStreamName?: string;
  cloudWatchLogsConsoleUrl?: string;
}

export interface MarathonMatchScorerTaskLaunchOptions {
  memberId?: string;
  stopSupersededMemberTasks?: boolean;
  validationRunId?: string;
  validationSubmissionDownloadUrl?: string;
}

interface ActiveScorerTask {
  taskArn: string;
  taskId: string;
  cluster: string;
  containerName: string;
  taskDefinition?: string;
  lastStatus?: string;
  desiredStatus?: string;
  challengeId?: string;
  submissionId?: string;
  memberId?: string;
  phaseConfigType?: string;
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
  private scorerLaunchLock: Promise<void> = Promise.resolve();

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
   * @param launchOptions Optional submission owner metadata, cancellation controls, and validation-run routing.
   * @returns ECS task launch details with task/log mapping metadata.
   * Required env vars: ECS_CLUSTER, ECS_CONTAINER_NAME, ECS_SUBNETS, ECS_SECURITY_GROUPS,
   * AWS_REGION, MARATHON_MATCH_API_URL, REVIEW_TYPE_ID, and Auth0 M2M settings
   * used by the runner to refresh tokens during long scoring tasks. Optional
   * ECS_SCORER_MAX_CONCURRENT_TASKS controls the global pending/running scorer
   * task cap when the role can list active ECS tasks and defaults to 20.
   * @throws Error when required ENV vars are missing, token fetch fails, the scorer task cap is reached
   * after active task lookup succeeds, or ECS launch/cancellation fails.
   */
  async launchScorerTask(
    challengeId: string,
    submissionId: string,
    mmConfig: MarathonMatchTaskConfig,
    scoringPhase: MarathonMatchScoringPhase,
    reviewId?: string,
    launchOptions: MarathonMatchScorerTaskLaunchOptions = {},
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
    const memberId = launchOptions.memberId?.trim();
    const validationRunId = launchOptions.validationRunId?.trim();
    const validationSubmissionDownloadUrl =
      launchOptions.validationSubmissionDownloadUrl?.trim();
    const shouldStopSupersededMemberTasks =
      launchOptions.stopSupersededMemberTasks !== false;

    if (!taskDefinitionName) {
      throw new Error('Missing required task definition name in mmConfig.');
    }

    if (!taskDefinitionVersion) {
      throw new Error('Missing required task definition version in mmConfig.');
    }

    const taskDefinition = `${taskDefinitionName}:${taskDefinitionVersion}`;

    try {
      return await this.runWithScorerLaunchLock(async () => {
        const activeTasks = await this.listActiveScorerTasksIfPermitted(
          cluster,
          taskDefinitionName,
          containerName,
        );
        const launchableActiveTasks = activeTasks
          ? shouldStopSupersededMemberTasks
            ? await this.stopSupersededMemberScorerTasks(cluster, activeTasks, {
                challengeId,
                submissionId,
                memberId,
              })
            : activeTasks
          : null;
        let maxConcurrentScorerTasks: number | null = null;

        if (launchableActiveTasks) {
          const duplicateTask = this.findDuplicateActiveScorerTask(
            launchableActiveTasks,
            challengeId,
            submissionId,
            scoringPhase.configType,
          );

          if (duplicateTask) {
            const launchResult = await this.buildLaunchResultFromActiveTask(
              duplicateTask,
              taskDefinition,
              containerName,
            );
            await this.persistSubmissionRunnerLogMapping({
              challengeId,
              submissionId,
              scoringPhase,
              launchResult,
            });
            this.logger.log({
              message: 'Skipped duplicate ECS scorer task launch',
              challengeId,
              submissionId,
              memberId: memberId ?? null,
              phaseConfigType: scoringPhase.configType,
              taskArn: launchResult.taskArn,
              taskId: launchResult.taskId,
            });
            return launchResult;
          }

          maxConcurrentScorerTasks = this.getMaxConcurrentScorerTasks();
          if (launchableActiveTasks.length >= maxConcurrentScorerTasks) {
            throw new Error(
              `ECS scorer task concurrency limit reached (${launchableActiveTasks.length}/${maxConcurrentScorerTasks}). Deferring submission ${submissionId} to Kafka retry/back-pressure instead of launching another task.`,
            );
          }
        }

        const token = await this.getM2MTokenForScorerLaunch();
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

        if (memberId) {
          runnerEnvironment.push({ name: 'MEMBER_ID', value: memberId });
        }

        if (reviewId?.trim()) {
          runnerEnvironment.push({
            name: 'REVIEW_ID',
            value: reviewId.trim(),
          });
        }

        if (validationRunId) {
          runnerEnvironment.push({
            name: 'VALIDATION_RUN_ID',
            value: validationRunId,
          });
        }

        if (validationSubmissionDownloadUrl) {
          runnerEnvironment.push({
            name: 'VALIDATION_SUBMISSION_DOWNLOAD_URL',
            value: this.resolveValidationSubmissionDownloadUrl(
              marathonMatchApiUrl,
              validationSubmissionDownloadUrl,
            ),
          });
        }

        this.appendOptionalEnvOverride(
          runnerEnvironment,
          'DEBUG_LOG_ACCESS_TOKEN',
        );
        this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_URL');
        this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_AUDIENCE');
        this.appendOptionalEnvOverride(
          runnerEnvironment,
          'AUTH0_PROXY_SERVER_URL',
        );
        this.appendOptionalEnvOverride(runnerEnvironment, 'AUTH0_CLIENT_ID');
        this.appendOptionalEnvOverride(
          runnerEnvironment,
          'AUTH0_CLIENT_SECRET',
        );

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
          memberId: memberId ?? null,
          taskDefinition,
          cluster,
          taskArn,
          taskId,
          logGroup: logGroup ?? null,
          logStreamPrefix: logStreamPrefix ?? null,
          logStreamName: logStreamName ?? null,
          cloudWatchLogsConsoleUrl: cloudWatchLogsConsoleUrl ?? null,
          activeScorerTaskCountBeforeLaunch:
            launchableActiveTasks?.length ?? null,
          maxConcurrentScorerTasks,
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
      });
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

  /**
   * Stops a previously launched ECS scorer task.
   * @param taskArn Task ARN to stop.
   * @param reason Human-readable stop reason stored by ECS.
   * @param clusterName Optional ECS cluster override. Defaults to ECS_CLUSTER env var.
   * @returns ECS task details returned by StopTask.
   * @throws Error when task ARN is missing or ECS stop fails.
   */
  async stopTask(
    taskArn: string,
    reason: string,
    clusterName?: string,
  ): Promise<Task> {
    const normalizedTaskArn = taskArn?.trim();
    if (!normalizedTaskArn) {
      throw new Error('Task ARN is required to stop an ECS task.');
    }

    const cluster = clusterName?.trim() || this.getRequiredEnv('ECS_CLUSTER');
    const normalizedReason =
      reason?.trim() || 'Marathon Match scorer task stopped by API.';

    try {
      const response = await this.ecsClient.send(
        new StopTaskCommand({
          cluster,
          task: normalizedTaskArn,
          reason: normalizedReason,
        }),
      );

      if (!response.task?.taskArn) {
        throw new Error(
          `ECS StopTask returned invalid task data for taskArn ${normalizedTaskArn}.`,
        );
      }

      this.logger.log({
        message: 'Stopped ECS scorer task',
        cluster,
        taskArn: response.task.taskArn,
        lastStatus: response.task.lastStatus,
        desiredStatus: response.task.desiredStatus,
        reason: normalizedReason,
      });

      return response.task;
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to stop ECS task ${normalizedTaskArn}: ${errorMessage}`,
      );
    }
  }

  /**
   * Serializes scorer task launch decisions in this API process so concurrent
   * requests cannot all pass the active-task check before calling ECS RunTask.
   * @param operation Launch decision and side effects to run under the lock.
   * @returns Operation result.
   */
  private async runWithScorerLaunchLock<T>(
    operation: () => Promise<T>,
  ): Promise<T> {
    const previousLock = this.scorerLaunchLock;
    let releaseLock: () => void = () => undefined;
    this.scorerLaunchLock = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });

    await previousLock;
    try {
      return await operation();
    } finally {
      releaseLock();
    }
  }

  /**
   * Retrieves the M2M token injected into trusted ECS runner container env.
   * @returns Access token for downstream API calls made by the runner.
   * @throws Error when token retrieval fails or returns an empty token.
   */
  private async getM2MTokenForScorerLaunch(): Promise<string> {
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

    return token;
  }

  /**
   * Resolves the configured global pending/running scorer task cap.
   * @returns Positive integer cap. Defaults to 20.
   * @throws Error when ECS_SCORER_MAX_CONCURRENT_TASKS is not a positive integer.
   */
  private getMaxConcurrentScorerTasks(): number {
    const rawLimit = process.env.ECS_SCORER_MAX_CONCURRENT_TASKS?.trim();
    if (!rawLimit) {
      return 20;
    }

    const parsedLimit = Number(rawLimit);
    if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
      throw new Error(
        'ECS_SCORER_MAX_CONCURRENT_TASKS must be a positive integer.',
      );
    }

    return parsedLimit;
  }

  /**
   * Lists active scorer tasks when ECS permissions allow it; otherwise logs and
   * returns null so scorer dispatch can continue through RunTask.
   * @param cluster ECS cluster name or ARN.
   * @param taskDefinitionName Task definition family configured for scoring.
   * @param containerName Runner container name whose overrides identify scorer tasks.
   * @returns Active scorer tasks, or null when listing/describing active tasks is not authorized.
   * @throws Error for non-permission ECS lookup failures.
   */
  private async listActiveScorerTasksIfPermitted(
    cluster: string,
    taskDefinitionName: string,
    containerName: string,
  ): Promise<ActiveScorerTask[] | null> {
    try {
      return await this.listActiveScorerTasks(
        cluster,
        taskDefinitionName,
        containerName,
      );
    } catch (error) {
      if (!this.isEcsPermissionError(error)) {
        throw error;
      }

      this.logger.warn({
        message:
          'Unable to inspect active ECS scorer tasks; launching without duplicate or concurrency checks.',
        cluster,
        taskDefinitionName,
        containerName,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Lists active scorer tasks for the configured task family and container.
   * @param cluster ECS cluster name or ARN.
   * @param taskDefinitionName Task definition family configured for scoring.
   * @param containerName Runner container name whose overrides identify scorer tasks.
   * @returns Active scorer task summaries parsed from ECS task overrides.
   */
  private async listActiveScorerTasks(
    cluster: string,
    taskDefinitionName: string,
    containerName: string,
  ): Promise<ActiveScorerTask[]> {
    const taskArns = new Set<string>();

    for (const desiredStatus of ['PENDING', 'RUNNING'] as const) {
      let nextToken: string | undefined;
      do {
        const response = await this.ecsClient.send(
          new ListTasksCommand({
            cluster,
            family: taskDefinitionName,
            desiredStatus,
            nextToken,
          }),
        );

        for (const taskArn of response.taskArns ?? []) {
          taskArns.add(taskArn);
        }

        nextToken = response.nextToken;
      } while (nextToken);
    }

    if (taskArns.size === 0) {
      return [];
    }

    const activeTasks: ActiveScorerTask[] = [];
    const taskArnList = Array.from(taskArns);
    for (let index = 0; index < taskArnList.length; index += 100) {
      const taskArnBatch = taskArnList.slice(index, index + 100);
      const response = await this.ecsClient.send(
        new DescribeTasksCommand({
          cluster,
          tasks: taskArnBatch,
        }),
      );

      for (const task of response.tasks ?? []) {
        const activeTask = this.extractActiveScorerTask(
          cluster,
          task,
          containerName,
        );
        if (activeTask) {
          activeTasks.push(activeTask);
        }
      }
    }

    return activeTasks;
  }

  /**
   * Detects AWS authorization failures for optional ECS inspection calls.
   * @param error Error thrown by the AWS SDK.
   * @returns True when the error represents a denied ECS action.
   * Used by scorer launches to fall back to direct RunTask dispatch when active
   * task inspection is not permitted in an environment.
   */
  private isEcsPermissionError(error: unknown): boolean {
    const typedError = error as {
      name?: unknown;
      Code?: unknown;
      code?: unknown;
      message?: unknown;
    };
    const values = [
      typedError.name,
      typedError.Code,
      typedError.code,
      typedError.message,
    ]
      .map((value) =>
        typeof value === 'string' ? value.trim().toLowerCase() : '',
      )
      .filter(Boolean);

    return values.some(
      (value) =>
        value.includes('accessdenied') ||
        value.includes('access denied') ||
        value.includes('not authorized') ||
        value.includes('unauthorized'),
    );
  }

  /**
   * Converts an ECS task description into active scorer task metadata.
   * @param cluster ECS cluster used for the task.
   * @param task ECS task description.
   * @param containerName Runner container name whose env overrides are inspected.
   * @returns Active scorer task metadata, or null for stopped/non-scorer tasks.
   */
  private extractActiveScorerTask(
    cluster: string,
    task: Task,
    containerName: string,
  ): ActiveScorerTask | null {
    if (!task.taskArn || this.isStoppedTaskStatus(task)) {
      return null;
    }

    const containerOverrides = task.overrides?.containerOverrides ?? [];
    const containerOverride =
      containerOverrides.find((override) => override.name === containerName) ??
      (containerOverrides.length === 1 ? containerOverrides[0] : undefined);
    if (!containerOverride) {
      return null;
    }

    const environment = this.mapContainerOverrideEnvironment(
      containerOverride.environment,
    );
    const challengeId = environment.get('TESTER_CONFIG_ID');
    const activeSubmissionId = environment.get('SUBMISSION_ID');
    if (!challengeId || !activeSubmissionId) {
      return null;
    }

    return {
      taskArn: task.taskArn,
      taskId: this.extractTaskId(task.taskArn),
      cluster,
      containerName,
      taskDefinition: task.taskDefinitionArn,
      lastStatus: task.lastStatus,
      desiredStatus: task.desiredStatus,
      challengeId,
      submissionId: activeSubmissionId,
      memberId: environment.get('MEMBER_ID'),
      phaseConfigType: environment.get('PHASE_CONFIG_TYPE'),
    };
  }

  /**
   * Determines whether an ECS task has already begun or completed shutdown.
   * @param task ECS task description.
   * @returns True when the task should no longer count against launch capacity.
   */
  private isStoppedTaskStatus(task: Task): boolean {
    const desiredStatus = task.desiredStatus?.trim().toUpperCase();
    const lastStatus = task.lastStatus?.trim().toUpperCase();
    return desiredStatus === 'STOPPED' || lastStatus === 'STOPPED';
  }

  /**
   * Builds a name/value lookup from ECS container override environment entries.
   * @param environment Container override environment from ECS DescribeTasks.
   * @returns Map keyed by environment variable name.
   */
  private mapContainerOverrideEnvironment(
    environment?: Array<{ name?: string; value?: string }>,
  ): Map<string, string> {
    const values = new Map<string, string>();
    for (const entry of environment ?? []) {
      const name = entry.name?.trim();
      const value = entry.value?.trim();
      if (name && value) {
        values.set(name, value);
      }
    }
    return values;
  }

  /**
   * Stops older active scorer tasks for the same challenge/member before the
   * new submission is launched.
   * @param cluster ECS cluster name or ARN.
   * @param activeTasks Currently active scorer tasks.
   * @param input New submission identity.
   * @returns Active task list excluding tasks that were asked to stop.
   */
  private async stopSupersededMemberScorerTasks(
    cluster: string,
    activeTasks: ActiveScorerTask[],
    input: { challengeId: string; submissionId: string; memberId?: string },
  ): Promise<ActiveScorerTask[]> {
    const memberId = input.memberId?.trim();
    if (!memberId) {
      return activeTasks;
    }

    const supersededTasks = activeTasks.filter(
      (task) =>
        task.challengeId === input.challengeId &&
        task.memberId === memberId &&
        task.submissionId !== input.submissionId,
    );

    if (supersededTasks.length === 0) {
      return activeTasks;
    }

    for (const task of supersededTasks) {
      await this.ecsClient.send(
        new StopTaskCommand({
          cluster,
          task: task.taskArn,
          reason: `Superseded by newer Marathon Match submission ${input.submissionId} for challenge ${input.challengeId}.`,
        }),
      );
      this.logger.log({
        message: 'Stopped superseded ECS scorer task',
        challengeId: input.challengeId,
        memberId,
        supersededSubmissionId: task.submissionId,
        replacementSubmissionId: input.submissionId,
        taskArn: task.taskArn,
        taskId: task.taskId,
      });
    }

    const stoppedTaskArns = new Set(
      supersededTasks.map((task) => task.taskArn),
    );
    return activeTasks.filter((task) => !stoppedTaskArns.has(task.taskArn));
  }

  /**
   * Finds an active scorer task for the same challenge, submission, and phase.
   * @param activeTasks Currently active scorer tasks.
   * @param challengeId Challenge ID about to be launched.
   * @param submissionId Submission ID about to be launched.
   * @param phaseConfigType Phase config type about to be launched.
   * @returns Matching active task when a duplicate launch should be skipped.
   */
  private findDuplicateActiveScorerTask(
    activeTasks: ActiveScorerTask[],
    challengeId: string,
    submissionId: string,
    phaseConfigType: string,
  ): ActiveScorerTask | undefined {
    const normalizedPhaseConfigType =
      this.normalizePhaseConfigTypeValue(phaseConfigType);
    return activeTasks.find((task) => {
      if (
        task.challengeId !== challengeId ||
        task.submissionId !== submissionId
      ) {
        return false;
      }

      const activePhaseConfigType = this.normalizePhaseConfigTypeValue(
        task.phaseConfigType,
      );
      return (
        !activePhaseConfigType ||
        activePhaseConfigType === normalizedPhaseConfigType
      );
    });
  }

  /**
   * Builds launch metadata for an already-running duplicate scorer task.
   * @param activeTask Existing active scorer task.
   * @param fallbackTaskDefinition Configured task definition name:revision.
   * @param containerName Runner container name.
   * @returns Launch result-compatible metadata with reusedExistingTask set.
   */
  private async buildLaunchResultFromActiveTask(
    activeTask: ActiveScorerTask,
    fallbackTaskDefinition: string,
    containerName: string,
  ): Promise<MarathonMatchScorerTaskLaunchResult> {
    const taskDefinitionForLogLookup =
      activeTask.taskDefinition ?? fallbackTaskDefinition;
    const logConfiguration = await this.resolveAwsLogsConfiguration(
      taskDefinitionForLogLookup,
      containerName,
    );
    const logGroup = logConfiguration.logGroup;
    const logStreamPrefix = logConfiguration.logStreamPrefix;
    const logStreamName = this.buildAwsLogsStreamName(
      logStreamPrefix,
      containerName,
      activeTask.taskId,
    );

    return {
      taskArn: activeTask.taskArn,
      taskId: activeTask.taskId,
      cluster: activeTask.cluster,
      containerName,
      taskDefinition: fallbackTaskDefinition,
      reusedExistingTask: true,
      logGroup,
      logStreamPrefix,
      logStreamName,
      cloudWatchLogsConsoleUrl: this.buildCloudWatchLogsConsoleUrl(
        logGroup,
        logStreamName,
      ),
    };
  }

  /**
   * Normalizes scorer phase config types for duplicate-task comparisons.
   * @param configType Raw phase config type.
   * @returns Uppercase config type, or undefined when absent.
   */
  private normalizePhaseConfigTypeValue(
    configType?: string,
  ): string | undefined {
    const normalized = configType?.trim().toUpperCase();
    return normalized || undefined;
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

  /**
   * Resolves a validation submission download location for ECS env overrides.
   * @param marathonMatchApiUrl Base Marathon Match API URL configured for the runner.
   * @param downloadUrl Absolute URL or API path supplied by the caller.
   * @returns Absolute URL under the normalized Marathon Match API base that
   * the runner can fetch with its M2M token. Used when launching isolated
   * Score Operations validation runs.
   */
  private resolveValidationSubmissionDownloadUrl(
    marathonMatchApiUrl: string,
    downloadUrl: string,
  ): string {
    const normalizedDownloadUrl = downloadUrl.trim();
    if (/^https?:\/\//i.test(normalizedDownloadUrl)) {
      return normalizedDownloadUrl;
    }

    const baseUrl = this.buildMarathonMatchApiBaseUrl(marathonMatchApiUrl);
    const path = normalizedDownloadUrl.startsWith('/')
      ? normalizedDownloadUrl
      : `/${normalizedDownloadUrl}`;
    return `${baseUrl}${path}`;
  }

  /**
   * Normalizes configured Marathon Match API roots to the versioned service
   * base used by the ECS runner.
   * @param marathonMatchApiUrl Raw MARATHON_MATCH_API_URL value from env.
   * @returns API base ending in /v6/marathon-match.
   * Used when backend-created runner URLs need to match runner-created API URLs.
   * Does not raise exceptions; required-env validation happens before this helper is called.
   */
  private buildMarathonMatchApiBaseUrl(marathonMatchApiUrl: string): string {
    const normalized = marathonMatchApiUrl.trim().replace(/\/+$/, '');

    if (normalized.endsWith('/v6/marathon-match')) {
      return normalized;
    }

    if (normalized.endsWith('/v6')) {
      return `${normalized}/marathon-match`;
    }

    return `${normalized}/v6/marathon-match`;
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
