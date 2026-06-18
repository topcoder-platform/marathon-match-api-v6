import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
} from '@aws-sdk/client-ecs';

jest.mock('./prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { EcsService } from './ecs.service';
import { LoggerService } from './logger.service';

describe('EcsService', () => {
  const originalEnv = process.env;
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const createService = () => {
    const m2mService = {
      getM2MToken: jest.fn().mockResolvedValue('m2m-token'),
    };
    const prisma = {
      submissionRunnerLog: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new EcsService(m2mService as never, prisma as never);
    const send = jest.fn();
    (service as any).ecsClient.send = send;

    return {
      service,
      m2mService,
      prisma,
      send,
    };
  };

  const baseTaskConfig = {
    taskDefinitionName: 'mm-ecs-runner',
    taskDefinitionVersion: '7',
  };

  const basePhaseConfig = {
    configType: 'PROVISIONAL',
    startSeed: BigInt(1),
    numberOfTests: 10,
  };

  const activeTask = (overrides: {
    taskArn?: string;
    challengeId?: string;
    submissionId?: string;
    memberId?: string;
    phaseConfigType?: string;
  }) => ({
    taskArn:
      overrides.taskArn ??
      'arn:aws:ecs:us-east-1:123456789012:task/cluster/active-task',
    taskDefinitionArn:
      'arn:aws:ecs:us-east-1:123456789012:task-definition/mm-ecs-runner:7',
    lastStatus: 'RUNNING',
    desiredStatus: 'RUNNING',
    overrides: {
      containerOverrides: [
        {
          name: 'tc-mm-runner',
          environment: [
            {
              name: 'TESTER_CONFIG_ID',
              value: overrides.challengeId ?? 'challenge-1',
            },
            {
              name: 'SUBMISSION_ID',
              value: overrides.submissionId ?? 'submission-1',
            },
            {
              name: 'MEMBER_ID',
              value: overrides.memberId ?? 'member-1',
            },
            {
              name: 'PHASE_CONFIG_TYPE',
              value: overrides.phaseConfigType ?? 'PROVISIONAL',
            },
          ],
        },
      ],
    },
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      AWS_REGION: 'us-east-1',
      ECS_CLUSTER: 'cluster-1',
      ECS_CONTAINER_NAME: 'tc-mm-runner',
      ECS_SUBNETS: 'subnet-1,subnet-2',
      ECS_SECURITY_GROUPS: 'sg-1',
      MARATHON_MATCH_API_URL: 'https://api.example.com',
      REVIEW_TYPE_ID: 'review-type-1',
      ECS_SCORER_MAX_CONCURRENT_TASKS: '20',
      AUTH0_URL: 'https://topcoder-dev.auth0.com/oauth/token',
      AUTH0_AUDIENCE: 'https://m2m.topcoder-dev.com/',
      AUTH0_PROXY_SERVER_URL: 'https://auth-proxy.topcoder-dev.com/oauth/token',
      AUTH0_CLIENT_ID: 'runner-client-id',
      AUTH0_CLIENT_SECRET: 'runner-client-secret',
    };
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = originalEnv;
  });

  it('reuses an active task for the same challenge, submission, and phase', async () => {
    const { service, m2mService, prisma, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve(
          command.input.desiredStatus === 'RUNNING'
            ? {
                taskArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/active-task',
                ],
              }
            : { taskArns: [] },
        );
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [activeTask({})],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: {
            containerDefinitions: [
              {
                name: 'tc-mm-runner',
                logConfiguration: {
                  options: {
                    'awslogs-group': '/ecs/mm-runner',
                    'awslogs-stream-prefix': 'ecs',
                  },
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const result = await service.launchScorerTask(
      'challenge-1',
      'submission-1',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      { memberId: 'member-1' },
    );

    expect(result.reusedExistingTask).toBe(true);
    expect(result.taskId).toBe('active-task');
    expect(result.logStreamName).toBe('ecs/tc-mm-runner/active-task');
    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(([command]) => command instanceof RunTaskCommand),
    ).toBe(false);
    expect(prisma.submissionRunnerLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskArn:
            'arn:aws:ecs:us-east-1:123456789012:task/cluster/active-task',
        },
      }),
    );
  });

  it('stops older active tasks for the same challenge and member before launching', async () => {
    const { service, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve(
          command.input.desiredStatus === 'RUNNING'
            ? {
                taskArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
                ],
              }
            : { taskArns: [] },
        );
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [
            activeTask({
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
              submissionId: 'old-submission',
            }),
          ],
        });
      }
      if (command instanceof StopTaskCommand) {
        return Promise.resolve({});
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/new-task',
            },
          ],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({ taskDefinition: {} });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await service.launchScorerTask(
      'challenge-1',
      'new-submission',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      { memberId: 'member-1' },
    );

    const sentCommands = send.mock.calls.map((call) => call[0] as unknown);
    const stopCommand = sentCommands.find(
      (command): command is StopTaskCommand =>
        command instanceof StopTaskCommand,
    );
    expect(stopCommand?.input).toEqual(
      expect.objectContaining({
        cluster: 'cluster-1',
        task: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
      }),
    );

    const runCommand = sentCommands.find(
      (command): command is RunTaskCommand => command instanceof RunTaskCommand,
    );
    expect(
      runCommand?.input.overrides?.containerOverrides?.[0]?.environment,
    ).toEqual(
      expect.arrayContaining([{ name: 'MEMBER_ID', value: 'member-1' }]),
    );
  });

  it('keeps older active tasks when superseded task stopping is disabled', async () => {
    const { service, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve(
          command.input.desiredStatus === 'RUNNING'
            ? {
                taskArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
                ],
              }
            : { taskArns: [] },
        );
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [
            activeTask({
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
              submissionId: 'old-submission',
            }),
          ],
        });
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/new-task',
            },
          ],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({ taskDefinition: {} });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await service.launchScorerTask(
      'challenge-1',
      'new-submission',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      {
        memberId: 'member-1',
        stopSupersededMemberTasks: false,
      },
    );

    const sentCommands = send.mock.calls.map((call) => call[0] as unknown);
    expect(
      sentCommands.some((command) => command instanceof StopTaskCommand),
    ).toBe(false);
    expect(
      sentCommands.some((command) => command instanceof RunTaskCommand),
    ).toBe(true);
  });

  it('passes validation run routing to scorer tasks', async () => {
    const { service, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve({ taskArns: [] });
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/validation-task',
            },
          ],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({ taskDefinition: {} });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await service.launchScorerTask(
      'challenge-1',
      'validation-run-1',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      {
        validationRunId: 'validation-run-1',
        validationSubmissionDownloadUrl:
          '/challenge/challenge-1/test-submission/validation-run-1/download',
      },
    );

    const runCommand = send.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (command): command is RunTaskCommand =>
          command instanceof RunTaskCommand,
      );
    expect(
      runCommand?.input.overrides?.containerOverrides?.[0]?.environment,
    ).toEqual(
      expect.arrayContaining([
        { name: 'VALIDATION_RUN_ID', value: 'validation-run-1' },
        {
          name: 'VALIDATION_SUBMISSION_DOWNLOAD_URL',
          value:
            'https://api.example.com/challenge/challenge-1/test-submission/validation-run-1/download',
        },
      ]),
    );
  });

  it('blocks new launches when the global scorer task cap is reached', async () => {
    process.env.ECS_SCORER_MAX_CONCURRENT_TASKS = '1';
    const { service, m2mService, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve(
          command.input.desiredStatus === 'RUNNING'
            ? {
                taskArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/active-task',
                ],
              }
            : { taskArns: [] },
        );
      }
      if (command instanceof DescribeTasksCommand) {
        return Promise.resolve({
          tasks: [
            activeTask({
              memberId: 'member-2',
              submissionId: 'other-submission',
            }),
          ],
        });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await expect(
      service.launchScorerTask(
        'challenge-1',
        'submission-1',
        baseTaskConfig,
        basePhaseConfig,
        undefined,
        { memberId: 'member-1' },
      ),
    ).rejects.toThrow('ECS scorer task concurrency limit reached (1/1)');

    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(
      send.mock.calls.some(([command]) => command instanceof RunTaskCommand),
    ).toBe(false);
  });

  it('launches scorer tasks when active task listing is not permitted', async () => {
    const { service, m2mService, prisma, send } = createService();
    m2mService.getM2MToken.mockResolvedValue('launch-token');
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.reject(
          Object.assign(
            new Error('User is not authorized to perform: ecs:ListTasks'),
            {
              name: 'AccessDeniedException',
            },
          ),
        );
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123',
            },
          ],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: {
            containerDefinitions: [
              {
                name: 'tc-mm-runner',
                logConfiguration: {
                  options: {
                    'awslogs-group': '/ecs/mm-runner',
                    'awslogs-stream-prefix': 'mm',
                  },
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const result = await service.launchScorerTask(
      'challenge-1',
      'submission-1',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      { memberId: 'member-1' },
    );

    expect(result.taskId).toBe('task-123');
    expect(result.logStreamName).toBe('mm/tc-mm-runner/task-123');
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(
      send.mock.calls.some(([command]) => command instanceof RunTaskCommand),
    ).toBe(true);
    expect(
      send.mock.calls.some(([command]) => command instanceof StopTaskCommand),
    ).toBe(false);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        message:
          'Unable to inspect active ECS scorer tasks; launching without duplicate or concurrency checks.',
        taskDefinitionName: 'mm-ecs-runner',
      }),
    );
    expect(prisma.submissionRunnerLog.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123',
        },
      }),
    );
  });

  it('passes Auth0 refresh settings to the ECS runner for long system scoring callbacks', async () => {
    const { service, m2mService, send } = createService();
    m2mService.getM2MToken.mockResolvedValue('launch-token');
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve({ taskArns: [] });
      }
      if (command instanceof RunTaskCommand) {
        return Promise.resolve({
          tasks: [
            {
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-123',
            },
          ],
        });
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return Promise.resolve({
          taskDefinition: {
            containerDefinitions: [
              {
                name: 'tc-mm-runner',
                logConfiguration: {
                  options: {
                    'awslogs-group': '/ecs/mm-runner',
                    'awslogs-stream-prefix': 'mm',
                  },
                },
              },
            ],
          },
        });
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await service.launchScorerTask(
      'challenge-1',
      'submission-1',
      {
        taskDefinitionName: 'mm-ecs-runner',
        taskDefinitionVersion: '42',
      },
      {
        configType: 'SYSTEM',
        startSeed: '85347878932952',
        numberOfTests: 5000,
      },
      'review-1',
    );

    const runTaskCommand = send.mock.calls
      .map((call) => call[0] as unknown)
      .find(
        (command): command is RunTaskCommand =>
          command instanceof RunTaskCommand,
      );
    if (!runTaskCommand) {
      throw new Error('Expected RunTaskCommand to be sent.');
    }
    const environment =
      runTaskCommand.input.overrides?.containerOverrides?.[0]?.environment ??
      [];
    const environmentByName = new Map(
      environment.map(({ name, value }) => [name, value]),
    );

    expect(environmentByName.get('ACCESS_TOKEN')).toBe('launch-token');
    expect(environmentByName.get('AUTH0_URL')).toBe(
      'https://topcoder-dev.auth0.com/oauth/token',
    );
    expect(environmentByName.get('AUTH0_AUDIENCE')).toBe(
      'https://m2m.topcoder-dev.com/',
    );
    expect(environmentByName.get('AUTH0_PROXY_SERVER_URL')).toBe(
      'https://auth-proxy.topcoder-dev.com/oauth/token',
    );
    expect(environmentByName.get('AUTH0_CLIENT_ID')).toBe('runner-client-id');
    expect(environmentByName.get('AUTH0_CLIENT_SECRET')).toBe(
      'runner-client-secret',
    );
    expect(environmentByName.get('TEST_PHASE')).toBe('system');
    expect(environmentByName.get('PHASE_NUMBER_OF_TESTS')).toBe('5000');
    expect(environmentByName.get('REVIEW_ID')).toBe('review-1');
    expect(environmentByName.has('DEBUG_LOG_FULL_ACCESS_TOKEN')).toBe(false);
  });
});
