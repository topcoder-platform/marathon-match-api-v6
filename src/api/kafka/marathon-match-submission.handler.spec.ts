import { CompilationStatus } from '@prisma/client';
import { of, throwError } from 'rxjs';
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
      post: jest.fn(),
      put: jest.fn(),
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
      m2mService,
      httpService,
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
    const { handler, prisma, m2mService, httpService, ecsService } =
      createHandler();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: 'challenge-1',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
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

    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          id: 'submission-1',
          virusScan: true,
        },
      }),
    );
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
      undefined,
      { memberId: 'member-1' },
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
      undefined,
      { memberId: 'member-1' },
    );
  });

  it('logs outbound URL details when submission-api preflight returns 403', async () => {
    const originalSubmissionApiUrl = process.env.SUBMISSION_API_URL;
    delete process.env.SUBMISSION_API_URL;
    const { handler, prisma, m2mService, httpService, ecsService } =
      createHandler();
    const submissionUrl =
      'https://api.topcoder.com/v6/submissions/submission-1';
    const axiosError = Object.assign(
      new Error('Request failed with status code 403'),
      {
        isAxiosError: true,
        config: {
          method: 'get',
          url: submissionUrl,
        },
        response: {
          status: 403,
          statusText: 'Forbidden',
          data: {
            message: 'Forbidden',
          },
        },
      },
    );

    try {
      prisma.marathonMatchConfig.findUnique.mockResolvedValue({
        id: 'config-1',
        challengeId: 'challenge-1',
        active: true,
        submissionApiUrl: 'https://api.topcoder.com/v6',
        testerId: 'tester-1',
        taskDefinitionName: 'mm-ecs-runner',
        taskDefinitionVersion: '7',
        tester: {
          compilationStatus: CompilationStatus.SUCCESS,
        },
        phaseConfigs: [
          {
            id: 'phase-provisional',
            configType: 'PROVISIONAL',
            phaseId: 'submission-phase',
            startSeed: BigInt(500),
            numberOfTests: 20,
          },
        ],
      });

      (handler as any).getOpenPhaseResolution = jest.fn().mockResolvedValue({
        phaseIds: ['submission-phase'],
        phaseIdentifiers: ['submission-phase'],
      });

      m2mService.getM2MToken.mockResolvedValue('m2m-token');
      httpService.get.mockReturnValue(throwError(() => axiosError));

      await expect(
        handler.handle({
          submissionId: 'submission-1',
          challengeId: 'challenge-1',
          submissionUrl: 'https://example.com/submission.zip',
          memberHandle: 'tester',
          memberId: 'member-1',
          submittedDate: '2026-03-26T01:27:22.829Z',
        }),
      ).rejects.toThrow('Request failed with status code 403');

      expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
      expect(mockLogger.log).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Calling external API',
          operation: 'submission-api.get-submission',
          method: 'GET',
          url: submissionUrl,
          submissionId: 'submission-1',
        }),
      );
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'External API call failed',
          operation: 'submission-api.get-submission',
          method: 'GET',
          url: submissionUrl,
          submissionId: 'submission-1',
          httpError: expect.objectContaining({
            status: 403,
            method: 'GET',
            url: submissionUrl,
            responseData: '{"message":"Forbidden"}',
          }),
        }),
      );
    } finally {
      if (originalSubmissionApiUrl === undefined) {
        delete process.env.SUBMISSION_API_URL;
      } else {
        process.env.SUBMISSION_API_URL = originalSubmissionApiUrl;
      }
    }
  });

  it('marks configured submissions failed when no open phase matches the stored phase config', async () => {
    const { handler, prisma, m2mService, httpService, ecsService } =
      createHandler();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: 'challenge-1',
      active: true,
      testerId: 'tester-1',
      reviewScorecardId: 'scorecard-1',
      taskDefinitionName: 'mm-ecs-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
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
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          data: [],
        },
      }),
    );
    httpService.post.mockReturnValue(of({ data: { id: 'summation-1' } }));

    await handler.handle({
      submissionId: 'submission-1',
      challengeId: 'challenge-1',
      submissionUrl: 'https://example.com/submission.zip',
      memberHandle: 'tester',
      memberId: 'member-1',
      submittedDate: '2026-03-26T01:27:22.829Z',
    });

    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviewSummations',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
        params: {
          metadata: 'true',
          provisional: 'true',
          submissionId: 'submission-1',
        },
      }),
    );
    expect(httpService.post).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviewSummations',
      expect.objectContaining({
        aggregateScore: -1,
        isPassing: false,
        isProvisional: true,
        scorecardId: 'scorecard-1',
        submissionId: 'submission-1',
        metadata: expect.objectContaining({
          challengeId: 'challenge-1',
          marathonMatchScoringSkipped: true,
          testProcess: 'provisional',
          testProgress: 1,
          testStatus: 'FAILED',
          testType: 'provisional',
        }),
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
  });

  it('marks each matching phase failed without launching when submission has not passed virus scan', async () => {
    const { handler, prisma, m2mService, httpService, ecsService } =
      createHandler();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: 'challenge-1',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      testerId: 'tester-1',
      reviewScorecardId: 'scorecard-1',
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
      ],
    });

    (handler as any).getOpenPhaseResolution = jest.fn().mockResolvedValue({
      phaseIds: ['submission-phase'],
      phaseIdentifiers: ['submission-phase'],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            id: 'submission-1',
            virusScan: false,
          },
        }),
      )
      .mockReturnValue(
        of({
          data: {
            data: [],
          },
        }),
      );
    httpService.post.mockReturnValue(of({ data: { id: 'summation-1' } }));

    await handler.handle({
      submissionId: 'submission-1',
      challengeId: 'challenge-1',
      submissionUrl: 'https://example.com/submission.zip',
      memberHandle: 'tester',
      memberId: 'member-1',
      submittedDate: '2026-03-26T01:27:22.829Z',
    });

    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(httpService.post).toHaveBeenCalledTimes(2);
    expect(httpService.post).toHaveBeenNthCalledWith(
      1,
      'https://api.topcoder-dev.com/v6/reviewSummations',
      expect.objectContaining({
        aggregateScore: -1,
        isExample: true,
        isPassing: false,
        scorecardId: 'scorecard-1',
        submissionId: 'submission-1',
        metadata: expect.objectContaining({
          challengeId: 'challenge-1',
          marathonMatchScoringSkipped: true,
          testProgress: 1,
          testStatus: 'FAILED',
          testType: 'example',
        }),
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
    expect(httpService.post).toHaveBeenNthCalledWith(
      2,
      'https://api.topcoder-dev.com/v6/reviewSummations',
      expect.objectContaining({
        aggregateScore: -1,
        isPassing: false,
        isProvisional: true,
        scorecardId: 'scorecard-1',
        submissionId: 'submission-1',
        metadata: expect.objectContaining({
          challengeId: 'challenge-1',
          marathonMatchScoringSkipped: true,
          testProcess: 'provisional',
          testProgress: 1,
          testStatus: 'FAILED',
          testType: 'provisional',
        }),
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
  });
});
