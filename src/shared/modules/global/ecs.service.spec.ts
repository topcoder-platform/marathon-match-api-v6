import {
  DescribeTaskDefinitionCommand,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';
import { LoggerService } from './logger.service';

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'request-id'),
}));

import { EcsService } from './ecs.service';

describe('EcsService', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {
      ...originalEnv,
      AWS_REGION: 'us-east-1',
      ECS_CLUSTER: 'mm-cluster',
      ECS_CONTAINER_NAME: 'tc-mm-runner',
      ECS_SUBNETS: 'subnet-a,subnet-b',
      ECS_SECURITY_GROUPS: 'sg-a',
      MARATHON_MATCH_API_URL: 'https://api.topcoder-dev.com/v6/marathon-match',
      REVIEW_TYPE_ID: 'review-type-id',
      AUTH0_URL: 'https://topcoder-dev.auth0.com/oauth/token',
      AUTH0_AUDIENCE: 'https://m2m.topcoder-dev.com/',
      AUTH0_PROXY_SERVER_URL: 'https://auth-proxy.topcoder-dev.com/oauth/token',
      AUTH0_CLIENT_ID: 'runner-client-id',
      AUTH0_CLIENT_SECRET: 'runner-client-secret',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('passes Auth0 refresh settings to the ECS runner for long system scoring callbacks', async () => {
    jest.spyOn(LoggerService, 'forRoot').mockReturnValue({
      log: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
    } as never);
    const m2mService = {
      getM2MToken: jest.fn().mockResolvedValue('launch-token'),
    };
    const prisma = {
      submissionRunnerLog: {
        upsert: jest.fn().mockResolvedValue(undefined),
      },
    };
    const service = new EcsService(m2mService as never, prisma as never);
    const send = jest.fn(
      (command: RunTaskCommand | DescribeTaskDefinitionCommand) => {
        if (command instanceof RunTaskCommand) {
          return Promise.resolve({
            tasks: [
              {
                taskArn:
                  'arn:aws:ecs:us-east-1:123456789012:task/mm-cluster/task-123',
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

        throw new Error(`Unexpected command: ${command.constructor.name}`);
      },
    );
    (
      service as unknown as {
        ecsClient: { send: typeof send };
      }
    ).ecsClient = { send };

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
      .map(([command]) => command)
      .find((command) => command instanceof RunTaskCommand) as RunTaskCommand;
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
  });
});
