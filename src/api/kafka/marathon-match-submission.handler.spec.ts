import { CompilationStatus } from '@prisma/client';
jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { MarathonMatchSubmissionHandler } from './marathon-match-submission.handler';
import { LoggerService } from 'src/shared/modules/global/logger.service';

describe('MarathonMatchSubmissionHandler', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const createHandler = () => {
    const handlerRegistry = {
      registerHandler: jest.fn(),
    };
    const prisma = {
      marathonMatchConfig: {
        findUnique: jest.fn(),
      },
    };
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const httpService = {
      get: jest.fn(),
    };
    const ecsService = {
      launchScorerTask: jest.fn(),
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const handler = new MarathonMatchSubmissionHandler(
      handlerRegistry as never,
      prisma as never,
      mockLogger as never,
      m2mService as never,
      httpService as never,
      ecsService as never,
    );

    return {
      handler,
      prisma,
      ecsService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('launches example and provisional scorer tasks when both map to the same open phase', async () => {
    const { handler, prisma, ecsService } = createHandler();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: 'challenge-1',
      active: true,
      testerId: 'tester-1',
      taskDefinitionName: 'mm-ecs-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-example',
          configType: 'EXAMPLE',
          phaseId: 'submission-phase',
          startSeed: BigInt(1),
          numberOfTests: 10,
        },
        {
          id: 'phase-provisional',
          configType: 'PROVISIONAL',
          phaseId: 'submission-phase',
          startSeed: BigInt(500),
          numberOfTests: 20,
        },
        {
          id: 'phase-system',
          configType: 'SYSTEM',
          phaseId: 'review-phase',
          startSeed: BigInt(900),
          numberOfTests: 30,
        },
      ],
    });

    (handler as any).getOpenPhaseResolution = jest.fn().mockResolvedValue({
      phaseIds: ['submission-phase'],
      phaseIdentifiers: ['submission-phase'],
    });

    ecsService.launchScorerTask
      .mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:task/example',
        taskId: 'example-task',
        cluster: 'cluster-1',
        containerName: 'tc-mm-runner',
        taskDefinition: 'mm-ecs-runner:7',
      })
      .mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:task/provisional',
        taskId: 'provisional-task',
        cluster: 'cluster-1',
        containerName: 'tc-mm-runner',
        taskDefinition: 'mm-ecs-runner:7',
      });

    await handler.handle({
      submissionId: 'submission-1',
      challengeId: 'challenge-1',
      submissionUrl: 'https://example.com/submission.zip',
      memberHandle: 'tester',
      memberId: 'member-1',
      submittedDate: '2026-03-26T01:27:22.829Z',
    });

    expect(ecsService.launchScorerTask).toHaveBeenCalledTimes(2);
    expect(ecsService.launchScorerTask).toHaveBeenNthCalledWith(
      1,
      'challenge-1',
      'submission-1',
      {
        taskDefinitionName: 'mm-ecs-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: 'EXAMPLE',
        startSeed: BigInt(1),
        numberOfTests: 10,
      },
    );
    expect(ecsService.launchScorerTask).toHaveBeenNthCalledWith(
      2,
      'challenge-1',
      'submission-1',
      {
        taskDefinitionName: 'mm-ecs-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: 'PROVISIONAL',
        startSeed: BigInt(500),
        numberOfTests: 20,
      },
    );
  });
});
