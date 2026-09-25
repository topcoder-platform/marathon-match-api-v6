import {
  DescribeTaskDefinitionCommand,
  DescribeTasksCommand,
  ListTasksCommand,
  RunTaskCommand,
  StopTaskCommand,
  waitUntilTasksStopped,
} from '@aws-sdk/client-ecs';

jest.mock('@aws-sdk/client-ecs', () => ({
  ...jest.requireActual('@aws-sdk/client-ecs'),
  waitUntilTasksStopped: jest.fn(),
}));

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
        findMany: jest.fn().mockResolvedValue([]),
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
    (waitUntilTasksStopped as jest.Mock).mockResolvedValue({
      state: 'SUCCESS',
    });
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
            'https://api.example.com/v6/marathon-match/challenge/challenge-1/test-submission/validation-run-1/download',
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

  it('retains the inspection fallback for launches without a member identity', async () => {
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
      {},
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

  it('cancels the active scorer tasks a member still has running on a challenge', async () => {
    const { service, send } = createService();
    send.mockImplementation((command) => {
      if (command instanceof ListTasksCommand) {
        return Promise.resolve(
          command.input.desiredStatus === 'RUNNING'
            ? {
                taskArns: [
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
                  'arn:aws:ecs:us-east-1:123456789012:task/cluster/other-member-task',
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
            activeTask({
              taskArn:
                'arn:aws:ecs:us-east-1:123456789012:task/cluster/other-member-task',
              memberId: 'member-2',
              submissionId: 'other-member-submission',
            }),
          ],
        });
      }
      if (command instanceof StopTaskCommand) {
        return Promise.resolve({});
      }

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    const cancelledTasks = await service.cancelMemberScorerTasks({
      challengeId: 'challenge-1',
      submissionId: 'new-submission',
      memberId: 'member-1',
      taskDefinitionName: 'mm-ecs-runner',
    });

    expect(cancelledTasks).toEqual([
      {
        submissionId: 'old-submission',
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
        taskId: 'old-task',
        phaseConfigType: 'PROVISIONAL',
      },
    ]);

    const stopCommands = send.mock.calls
      .map((call) => call[0] as unknown)
      .filter(
        (command): command is StopTaskCommand =>
          command instanceof StopTaskCommand,
      );
    expect(stopCommands).toHaveLength(1);
    expect(stopCommands[0].input.task).toBe(
      'arn:aws:ecs:us-east-1:123456789012:task/cluster/old-task',
    );
  });

  it('rejects cancellation when active scorer task inspection is not permitted', async () => {
    const { service, send } = createService();
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

      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await expect(
      service.cancelMemberScorerTasks({
        challengeId: 'challenge-1',
        submissionId: 'new-submission',
        memberId: 'member-1',
        taskDefinitionName: 'mm-ecs-runner',
      }),
    ).rejects.toThrow('not authorized');
  });

  it('waits for a stopping duplicate instead of reusing a task that is shutting down', async () => {
    const { service, prisma, send } = createService();
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      { taskArn: 'stopping-task', submissionId: 'submission-1' },
    ]);
    send.mockImplementation(async (command) => {
      if (command instanceof ListTasksCommand) return { taskArns: [] };
      if (command instanceof DescribeTasksCommand) {
        return {
          tasks: [
            {
              ...activeTask({ taskArn: 'stopping-task' }),
              desiredStatus: 'STOPPED',
            },
          ],
        };
      }
      if (command instanceof RunTaskCommand) {
        expect(waitUntilTasksStopped).toHaveBeenCalled();
        return { tasks: [{ taskArn: 'replacement-task' }] };
      }
      if (command instanceof DescribeTaskDefinitionCommand)
        return { taskDefinition: {} };
      throw new Error('Unexpected ECS request');
    });
    const result = await service.launchScorerTask(
      'challenge-1',
      'submission-1',
      baseTaskConfig,
      basePhaseConfig,
      undefined,
      { memberId: 'member-1' },
    );
    expect(result.taskArn).toBe('replacement-task');
    expect(result.reusedExistingTask).not.toBe(true);
  });

  it('refuses a member launch when task inspection is denied', async () => {
    const { service, send } = createService();
    send.mockRejectedValue(new Error('AccessDeniedException: ecs:ListTasks'));

    await expect(
      service.launchScorerTask(
        'challenge-1',
        'new-submission',
        baseTaskConfig,
        basePhaseConfig,
        undefined,
        { memberId: 'member-1' },
      ),
    ).rejects.toThrow('AccessDeniedException');
    expect(
      send.mock.calls.some(([command]) => command instanceof RunTaskCommand),
    ).toBe(false);
  });

  it.each([false, true])(
    'persists cancellation before stopping a discovered task; failure=%s',
    async (fails) => {
      const { service, send } = createService();
      const events: string[] = [];
      send.mockImplementation(async (command) => {
        if (command instanceof ListTasksCommand)
          return { taskArns: ['old-task'] };
        if (command instanceof DescribeTasksCommand) {
          return {
            tasks: [
              activeTask({
                taskArn: 'old-task',
                submissionId: 'old-submission',
              }),
            ],
          };
        }
        if (command instanceof StopTaskCommand) {
          events.push('stop');
          return {};
        }
        throw new Error('Unexpected ECS request');
      });
      const beforeStop = jest.fn(async () => {
        events.push('persist');
        if (fails) throw new Error('Review API unavailable');
      });
      const operation = service.cancelMemberScorerTasks(
        {
          challengeId: 'challenge-1',
          memberId: 'member-1',
          submissionId: 'new-submission',
          taskDefinitionName: 'mm-ecs-runner',
        },
        beforeStop,
      );

      if (fails) {
        // The task keeps running rather than being stopped unrecorded.
        await expect(operation).resolves.toEqual([]);
        expect(events).toEqual(['persist']);
        expect(waitUntilTasksStopped).not.toHaveBeenCalled();
      } else {
        await expect(operation).resolves.toHaveLength(1);
        expect(events).toEqual(['persist', 'stop']);
        expect(waitUntilTasksStopped).toHaveBeenCalledWith(
          expect.objectContaining({ maxWaitTime: 120 }),
          { cluster: 'cluster-1', tasks: ['old-task'] },
        );
      }
    },
  );

  it('recovers a legacy runner from persisted ARNs before ListTasks has caught up', async () => {
    const { service, prisma, send } = createService();
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      { taskArn: 'known-old-task', submissionId: 'old-submission' },
    ]);
    const legacyTask = activeTask({
      taskArn: 'known-old-task',
      submissionId: 'old-submission',
    });
    legacyTask.overrides.containerOverrides[0].environment =
      legacyTask.overrides.containerOverrides[0].environment.filter(
        (entry) => entry.name !== 'MEMBER_ID',
      );
    send.mockImplementation(async (command) => {
      if (command instanceof ListTasksCommand) return { taskArns: [] };
      if (command instanceof DescribeTasksCommand)
        return { tasks: [legacyTask] };
      if (command instanceof StopTaskCommand) return {};
      throw new Error('Unexpected ECS request');
    });

    const result = await service.cancelMemberScorerTasks({
      challengeId: 'challenge-1',
      memberId: 'member-1',
      submissionId: 'new-submission',
      memberSubmissionIds: ['new-submission', 'old-submission'],
      taskDefinitionName: 'mm-ecs-runner',
    });
    expect(result).toEqual([
      expect.objectContaining({ submissionId: 'old-submission' }),
    ]);
    expect(prisma.submissionRunnerLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          challengeId: 'challenge-1',
          cluster: 'cluster-1',
          submissionId: { in: ['new-submission', 'old-submission'] },
        },
      }),
    );
  });

  it('dispatches the replacement when ECS does not confirm superseded shutdown in time', async () => {
    const { service, send } = createService();
    const oldTask = {
      ...activeTask({ taskArn: 'old-task', submissionId: 'old-submission' }),
      desiredStatus: 'STOPPED',
    };
    (waitUntilTasksStopped as jest.Mock).mockRejectedValue(
      new Error('shutdown not confirmed'),
    );
    send.mockImplementation(async (command) => {
      if (command instanceof ListTasksCommand) {
        return {
          taskArns:
            command.input.desiredStatus === 'STOPPED' ? ['old-task'] : [],
        };
      }
      if (command instanceof DescribeTasksCommand) return { tasks: [oldTask] };
      if (command instanceof StopTaskCommand) return {};
      if (command instanceof RunTaskCommand) {
        return { tasks: [{ taskArn: 'new-task' }] };
      }
      if (command instanceof DescribeTaskDefinitionCommand) {
        return { taskDefinition: {} };
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });

    await expect(
      service.launchScorerTask(
        'challenge-1',
        'new-submission',
        baseTaskConfig,
        basePhaseConfig,
        undefined,
        { memberId: 'member-1' },
      ),
    ).resolves.toEqual(expect.objectContaining({ taskArn: 'new-task' }));
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        replacementSubmissionId: 'new-submission',
        taskArns: ['old-task'],
        error: 'shutdown not confirmed',
      }),
    );
  });

  it('keeps cancelling the remaining superseded tasks when StopTask is denied for one', async () => {
    // QA regression for PM-5368: a denied StopTask on the old EXAMPLE task
    // aborted cancellation, so the old PROVISIONAL task kept running and the
    // newest submission was never dispatched.
    const { service, send } = createService();
    const exampleTask = activeTask({
      taskArn: 'old-example-task',
      submissionId: 'old-submission',
      phaseConfigType: 'EXAMPLE',
    });
    const provisionalTask = activeTask({
      taskArn: 'old-provisional-task',
      submissionId: 'old-submission',
      phaseConfigType: 'PROVISIONAL',
    });
    send.mockImplementation(async (command) => {
      if (command instanceof ListTasksCommand) {
        return {
          taskArns:
            command.input.desiredStatus === 'RUNNING'
              ? ['old-example-task', 'old-provisional-task']
              : [],
        };
      }
      if (command instanceof DescribeTasksCommand) {
        return { tasks: [exampleTask, provisionalTask] };
      }
      if (command instanceof StopTaskCommand) {
        if (command.input.task === 'old-example-task') {
          throw Object.assign(
            new Error('User is not authorized to perform: ecs:StopTask'),
            { name: 'AccessDeniedException' },
          );
        }
        return {};
      }
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const beforeStop = jest.fn().mockResolvedValue(undefined);

    const cancelledTasks = await service.cancelMemberScorerTasks(
      {
        challengeId: 'challenge-1',
        submissionId: 'new-submission',
        memberId: 'member-1',
        taskDefinitionName: 'mm-ecs-runner',
      },
      beforeStop,
    );

    expect(beforeStop.mock.calls.map(([task]) => task.phaseConfigType)).toEqual(
      ['EXAMPLE', 'PROVISIONAL'],
    );
    expect(cancelledTasks).toEqual([
      expect.objectContaining({
        taskArn: 'old-provisional-task',
        phaseConfigType: 'PROVISIONAL',
      }),
    ]);
    expect(waitUntilTasksStopped).toHaveBeenCalledWith(
      expect.anything(),
      { cluster: 'cluster-1', tasks: ['old-provisional-task'] },
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskArn: 'old-example-task',
        error: 'User is not authorized to perform: ecs:StopTask',
      }),
    );
  });

  it('leaves a superseded task running when its cancellation cannot be persisted', async () => {
    const { service, send } = createService();
    const exampleTask = activeTask({
      taskArn: 'old-example-task',
      submissionId: 'old-submission',
      phaseConfigType: 'EXAMPLE',
    });
    const provisionalTask = activeTask({
      taskArn: 'old-provisional-task',
      submissionId: 'old-submission',
      phaseConfigType: 'PROVISIONAL',
    });
    send.mockImplementation(async (command) => {
      if (command instanceof ListTasksCommand) {
        return {
          taskArns:
            command.input.desiredStatus === 'RUNNING'
              ? ['old-example-task', 'old-provisional-task']
              : [],
        };
      }
      if (command instanceof DescribeTasksCommand) {
        return { tasks: [exampleTask, provisionalTask] };
      }
      if (command instanceof StopTaskCommand) return {};
      throw new Error(`Unexpected command ${command.constructor.name}`);
    });
    const beforeStop = jest
      .fn()
      .mockRejectedValueOnce(new Error('review-api unavailable'))
      .mockResolvedValue(undefined);

    const cancelledTasks = await service.cancelMemberScorerTasks(
      {
        challengeId: 'challenge-1',
        submissionId: 'new-submission',
        memberId: 'member-1',
        taskDefinitionName: 'mm-ecs-runner',
      },
      beforeStop,
    );

    const stoppedTaskArns = send.mock.calls
      .map(([command]) => command as unknown)
      .filter(
        (command): command is StopTaskCommand =>
          command instanceof StopTaskCommand,
      )
      .map((command) => command.input.task);
    expect(stoppedTaskArns).toEqual(['old-provisional-task']);
    expect(cancelledTasks.map((task) => task.taskArn)).toEqual([
      'old-provisional-task',
    ]);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        taskArn: 'old-example-task',
        error: 'review-api unavailable',
      }),
    );
  });
});
