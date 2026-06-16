import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import {
  CompilationStatus,
  PhaseConfigType,
  ScoreDirection,
} from '@prisma/client';
import { of, throwError } from 'rxjs';

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'generated-id'),
}));

import { MarathonMatchConfigService } from './marathon-match-config.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';

describe('MarathonMatchConfigService', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const createService = () => {
    const httpService = {
      get: jest.fn(),
      post: jest.fn(),
    };
    const ecsService = {
      launchScorerTask: jest.fn(),
    };
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const prisma = {
      $transaction: jest.fn(),
      marathonMatchConfig: {
        create: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
      },
      phaseConfig: {
        create: jest.fn(),
        upsert: jest.fn(),
      },
      tester: {
        findUnique: jest.fn(),
      },
    };
    const prismaErrorService = {
      handleError: jest.fn(),
    };
    const scoringResultService = {
      markSubmissionScoringSkipped: jest.fn(),
      triggerSystemScore: jest.fn(),
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new MarathonMatchConfigService(
      httpService as never,
      ecsService as never,
      m2mService as never,
      prisma as never,
      prismaErrorService as never,
      scoringResultService as never,
    );

    return {
      service,
      ecsService,
      httpService,
      m2mService,
      prisma,
      prismaErrorService,
      scoringResultService,
    };
  };

  const flushPromises = async () => {
    for (let index = 0; index < 5; index += 1) {
      await Promise.resolve();
    }
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  const createConfigPayload = () => ({
    name: 'MM June 2026 Config',
    reviewScorecardId: 'scorecard-1',
    testerId: 'tester-1',
    testTimeout: 90000,
    compileTimeout: 120000,
    taskDefinitionName: 'mm-runner',
    taskDefinitionVersion: '7',
  });

  it('defaults total system test timeout to 24 hours', () => {
    const originalReviewScorecardId = process.env.DEFAULT_REVIEW_SCORECARD_ID;
    const originalSystemTestTimeout =
      process.env.DEFAULT_SYSTEM_TEST_TIMEOUT_MS;
    process.env.DEFAULT_REVIEW_SCORECARD_ID = 'scorecard-1';
    delete process.env.DEFAULT_SYSTEM_TEST_TIMEOUT_MS;

    try {
      const { service } = createService();
      const defaults = service.getDefaults();

      expect(defaults.systemTestTimeout).toBe(86400000);
    } finally {
      if (originalReviewScorecardId === undefined) {
        delete process.env.DEFAULT_REVIEW_SCORECARD_ID;
      } else {
        process.env.DEFAULT_REVIEW_SCORECARD_ID = originalReviewScorecardId;
      }
      if (originalSystemTestTimeout === undefined) {
        delete process.env.DEFAULT_SYSTEM_TEST_TIMEOUT_MS;
      } else {
        process.env.DEFAULT_SYSTEM_TEST_TIMEOUT_MS = originalSystemTestTimeout;
      }
    }
  });

  it('resolves legacy review scorecard ids when loading one config', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      name: 'Bridge Runners',
      active: true,
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      reviewScorecardId: '12345',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-02T00:00:00.000Z'),
      createdBy: 'admin',
      updatedBy: 'admin',
      phaseConfigs: [
        {
          id: 'phase-system',
          configType: PhaseConfigType.SYSTEM,
          startSeed: BigInt(100),
          numberOfTests: 50,
          phaseId: 'review-phase',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-02T00:00:00.000Z'),
          marathonMatchConfigId: 'config-1',
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          id: 'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
        },
      }),
    );

    const result = await service.getConfig('30000123', {
      isMachine: false,
      userId: '40051399',
    } as never);

    expect(result.reviewScorecardId).toBe(
      'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
    );
    expect(result.system?.startSeed).toBe('100');
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/scorecards/12345',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
  });

  it('rejects update requests when reviewScorecardId cannot be resolved', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      testerId: 'tester-1',
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      throwError(() => ({
        message: 'Request failed with status code 404',
        response: {
          status: 404,
          data: {
            message: 'Scorecard not found',
          },
        },
      })),
    );

    await expect(
      service.updateConfig(
        '30000123',
        {
          reviewScorecardId: 'x',
        },
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/scorecards/x',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
  });

  it('reruns latest submissions after an active config tester change', async () => {
    const { service, prisma } = createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;
    const rerunSpy = jest
      .spyOn(service, 'rerunLatestSubmissions')
      .mockResolvedValue({
        challengeId: '30000123',
        submissionsQueued: 1,
        results: [
          {
            submissionId: 'submission-1',
            configType: PhaseConfigType.PROVISIONAL,
            taskId: 'task-1',
          },
        ],
      });

    prisma.marathonMatchConfig.findUnique
      .mockResolvedValueOnce({
        id: 'config-1',
        challengeId: '30000123',
        active: true,
        testerId: 'tester-old',
      })
      .mockResolvedValueOnce({
        id: 'config-1',
        challengeId: '30000123',
        name: 'Bridge Runners',
        active: true,
        relativeScoringEnabled: true,
        scoreDirection: ScoreDirection.MAXIMIZE,
        submissionApiUrl: 'https://api.topcoder-dev.com/v6',
        reviewScorecardId: 'scorecard-1',
        testerId: 'tester-new',
        testTimeout: 90000,
        compileTimeout: 120000,
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
        createdAt: new Date('2026-03-01T00:00:00.000Z'),
        updatedAt: new Date('2026-03-02T00:00:00.000Z'),
        createdBy: 'admin',
        updatedBy: '40051399',
        phaseConfigs: [],
      });
    prisma.tester.findUnique.mockResolvedValue({
      id: 'tester-new',
    });
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<void>) => callback(prisma),
    );
    prisma.marathonMatchConfig.update.mockResolvedValue({});

    const result = await service.updateConfig(
      '30000123',
      {
        testerId: 'tester-new',
      },
      user,
    );

    expect(result.testerId).toBe('tester-new');
    expect(prisma.marathonMatchConfig.update).toHaveBeenCalledWith({
      where: { challengeId: '30000123' },
      data: {
        testerId: 'tester-new',
        updatedBy: '40051399',
      },
    });
    expect(rerunSpy).toHaveBeenCalledTimes(1);
    expect(rerunSpy).toHaveBeenCalledWith('30000123', user);
  });

  it('reruns latest submissions with the currently open system phase config', async () => {
    const { service, ecsService, httpService, m2mService, prisma } =
      createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-example',
          configType: PhaseConfigType.EXAMPLE,
          phaseId: 'example-phase',
          startSeed: BigInt(1),
          numberOfTests: 10,
        },
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
        {
          id: 'phase-system',
          configType: PhaseConfigType.SYSTEM,
          phaseId: 'system-phase',
          startSeed: BigInt(1000),
          numberOfTests: 5000,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            status: 'ACTIVE',
            phases: [
              {
                phaseId: 'provisional-phase',
                isOpen: false,
                actualStartDate: '2026-05-01T00:00:00.000Z',
              },
              {
                phaseId: 'system-phase',
                isOpen: true,
                actualStartDate: '2026-06-01T00:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            result: {
              content: [
                {
                  id: 'submission-system',
                  memberId: '40051399',
                  submittedDate: '2026-06-02T00:00:00.000Z',
                  isLatest: true,
                  virusScan: true,
                },
              ],
            },
          },
          headers: {
            'x-total-pages': '1',
          },
        }),
      );
    ecsService.launchScorerTask.mockResolvedValue({
      taskArn: 'arn:aws:ecs:task/task-1',
      taskId: 'task-1',
      cluster: 'cluster-1',
      containerName: 'runner',
      taskDefinition: 'mm-runner:7',
    });

    const result = await service.rerunLatestSubmissions('30000123', user);

    expect(result.submissionsQueued).toBe(1);
    expect(ecsService.launchScorerTask).toHaveBeenCalledWith(
      '30000123',
      'submission-system',
      {
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: PhaseConfigType.SYSTEM,
        startSeed: BigInt(1000),
        numberOfTests: 5000,
      },
      undefined,
      {
        memberId: '40051399',
      },
    );
  });

  it('reruns all phase configs mapped to the currently open submission phase', async () => {
    const { service, ecsService, httpService, m2mService, prisma } =
      createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      reviewScorecardId: 'scorecard-1',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'submission-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
        {
          id: 'phase-example',
          configType: PhaseConfigType.EXAMPLE,
          phaseId: 'submission-phase',
          startSeed: BigInt(1),
          numberOfTests: 10,
        },
        {
          id: 'phase-system',
          configType: PhaseConfigType.SYSTEM,
          phaseId: 'system-phase',
          startSeed: BigInt(1000),
          numberOfTests: 5000,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            status: 'ACTIVE',
            phases: [
              {
                phaseId: 'registration-phase',
                isOpen: true,
                actualStartDate: '2026-06-01T00:00:00.000Z',
              },
              {
                phaseId: 'submission-phase',
                isOpen: true,
                actualStartDate: '2026-06-01T00:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            result: {
              content: [
                {
                  id: 'submission-1',
                  memberId: '40051399',
                  submittedDate: '2026-06-02T00:00:00.000Z',
                  isLatest: true,
                  virusScan: true,
                },
                {
                  id: 'submission-2',
                  memberId: '40051400',
                  submittedDate: '2026-06-03T00:00:00.000Z',
                  isLatest: true,
                  virusScan: true,
                },
              ],
            },
          },
          headers: {
            'x-total-pages': '1',
          },
        }),
      );
    ecsService.launchScorerTask.mockImplementation((...args: unknown[]) => {
      const submissionId = String(args[1]);
      const scoringPhase = args[3] as { configType: PhaseConfigType };
      return Promise.resolve({
        taskArn: `arn:aws:ecs:task/${scoringPhase.configType}-${submissionId}`,
        taskId: `${scoringPhase.configType}-${submissionId}`,
      });
    });

    const result = await service.rerunLatestSubmissions('30000123', user);

    expect(result).toEqual({
      challengeId: '30000123',
      submissionsQueued: 2,
      results: [
        {
          submissionId: 'submission-1',
          configType: PhaseConfigType.EXAMPLE,
          taskArn: 'arn:aws:ecs:task/EXAMPLE-submission-1',
          taskId: 'EXAMPLE-submission-1',
        },
        {
          submissionId: 'submission-2',
          configType: PhaseConfigType.EXAMPLE,
          taskArn: 'arn:aws:ecs:task/EXAMPLE-submission-2',
          taskId: 'EXAMPLE-submission-2',
        },
        {
          submissionId: 'submission-1',
          configType: PhaseConfigType.PROVISIONAL,
          taskArn: 'arn:aws:ecs:task/PROVISIONAL-submission-1',
          taskId: 'PROVISIONAL-submission-1',
        },
        {
          submissionId: 'submission-2',
          configType: PhaseConfigType.PROVISIONAL,
          taskArn: 'arn:aws:ecs:task/PROVISIONAL-submission-2',
          taskId: 'PROVISIONAL-submission-2',
        },
      ],
    });
    expect(ecsService.launchScorerTask).toHaveBeenCalledTimes(4);
    expect(ecsService.launchScorerTask).toHaveBeenNthCalledWith(
      1,
      '30000123',
      'submission-1',
      {
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: PhaseConfigType.EXAMPLE,
        startSeed: BigInt(1),
        numberOfTests: 10,
        scorecardId: 'scorecard-1',
      },
      undefined,
      {
        memberId: '40051399',
      },
    );
    expect(ecsService.launchScorerTask).toHaveBeenNthCalledWith(
      3,
      '30000123',
      'submission-1',
      {
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: PhaseConfigType.PROVISIONAL,
        startSeed: BigInt(100),
        numberOfTests: 50,
        scorecardId: 'scorecard-1',
      },
      undefined,
      {
        memberId: '40051399',
      },
    );
  });

  it('marks latest submissions failed without launching when virus scan has not passed', async () => {
    const {
      service,
      ecsService,
      httpService,
      m2mService,
      prisma,
      scoringResultService,
    } = createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      reviewScorecardId: 'scorecard-1',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    scoringResultService.markSubmissionScoringSkipped.mockResolvedValue(
      undefined,
    );
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            status: 'ACTIVE',
            phases: [
              {
                phaseId: 'provisional-phase',
                isOpen: true,
                actualStartDate: '2026-06-01T00:00:00.000Z',
              },
            ],
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            result: {
              content: [
                {
                  id: 'submission-1',
                  memberId: '40051399',
                  submittedDate: '2026-06-02T00:00:00.000Z',
                  isLatest: true,
                  virusScan: false,
                },
              ],
            },
          },
          headers: {
            'x-total-pages': '1',
          },
        }),
      );

    const result = await service.rerunLatestSubmissions('30000123', user);

    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
    expect(
      scoringResultService.markSubmissionScoringSkipped,
    ).toHaveBeenCalledWith({
      challengeId: '30000123',
      details: {
        virusScan: false,
      },
      reason:
        'Marathon Match PROVISIONAL scoring skipped because the submission has not passed virus scanning.',
      scorecardId: 'scorecard-1',
      submissionId: 'submission-1',
      testPhase: PhaseConfigType.PROVISIONAL,
    });
    expect(result).toEqual({
      challengeId: '30000123',
      submissionsQueued: 1,
      results: [
        {
          submissionId: 'submission-1',
          configType: PhaseConfigType.PROVISIONAL,
          error:
            'Marathon Match PROVISIONAL scoring skipped because the submission has not passed virus scanning.',
        },
      ],
    });
  });

  it('uploads a validation submission and queues scorer execution', async () => {
    const { service, ecsService, httpService, m2mService, prisma } =
      createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      testerId: 'tester-1',
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.post.mockReturnValue(
      of({
        data: {
          id: 'validation-submission-1',
        },
      }),
    );
    ecsService.launchScorerTask.mockResolvedValue({
      taskArn: 'arn:aws:ecs:task/task-1',
      taskId: 'task-1',
      cluster: 'cluster-1',
      containerName: 'runner',
      taskDefinition: 'mm-runner:7',
      cloudWatchLogsConsoleUrl: 'https://logs.example.com/task-1',
    });

    const result = await service.uploadTestSubmission(
      '30000123',
      {
        configType: PhaseConfigType.PROVISIONAL,
      },
      {
        buffer: Buffer.from('zip'),
        mimetype: 'application/zip',
        originalname: 'solution.zip',
        size: 3,
      } as Express.Multer.File,
      user,
    );

    const postedForm = httpService.post.mock.calls[0][1] as FormData;
    expect(result).toEqual({
      challengeId: '30000123',
      submissionId: 'validation-submission-1',
      configType: PhaseConfigType.PROVISIONAL,
      taskArn: 'arn:aws:ecs:task/task-1',
      taskId: 'task-1',
      cloudWatchLogsConsoleUrl: 'https://logs.example.com/task-1',
    });
    expect(httpService.post).toHaveBeenCalledWith(
      'https://submissions.example.com/v6/submissions/validation-upload',
      expect.any(FormData),
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
    expect(postedForm.get('challengeId')).toBe('30000123');
    expect(postedForm.get('memberId')).toBe('40051399');
    expect(postedForm.get('type')).toBe('CONTEST_SUBMISSION');
    expect(postedForm.get('submissionPhaseId')).toBe('provisional-phase');
    expect(ecsService.launchScorerTask).toHaveBeenCalledWith(
      '30000123',
      'validation-submission-1',
      {
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
      },
      {
        configType: PhaseConfigType.PROVISIONAL,
        startSeed: BigInt(100),
        numberOfTests: 50,
      },
      undefined,
      {
        memberId: '40051399',
      },
    );
  });

  it('preserves Review API validation upload authorization failures', async () => {
    const {
      service,
      ecsService,
      httpService,
      m2mService,
      prisma,
      prismaErrorService,
    } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      testerId: 'tester-1',
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.post.mockReturnValue(
      throwError(() => ({
        isAxiosError: true,
        message: 'Request failed with status code 403',
        response: {
          status: 403,
          data: {
            message: 'Insufficient permissions',
            code: 'FORBIDDEN',
          },
        },
      })),
    );

    let thrown: unknown;
    try {
      await service.uploadTestSubmission(
        '30000123',
        {
          configType: PhaseConfigType.PROVISIONAL,
        },
        {
          buffer: Buffer.from('zip'),
          mimetype: 'application/zip',
          originalname: 'solution.zip',
          size: 3,
        } as Express.Multer.File,
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    const exception = thrown as HttpException;
    expect(exception.getStatus()).toBe(403);
    expect(exception.getResponse()).toEqual({
      message:
        'Review API rejected the validation submission upload with 403 Forbidden. Confirm the Marathon Match M2M credentials are authorized for create:submission in Review API. Upstream message: Insufficient permissions',
      code: 'VALIDATION_SUBMISSION_UPLOAD_REJECTED',
      details: {
        challengeId: '30000123',
        memberId: '40051399',
        upstreamCode: 'FORBIDDEN',
        upstreamMessage: 'Insufficient permissions',
        upstreamStatusCode: 403,
      },
    });
    expect(prismaErrorService.handleError).not.toHaveBeenCalled();
    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
  });

  it('rejects validation submissions when the tester is not compiled', async () => {
    const { service, ecsService, httpService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      testerId: 'tester-1',
      tester: {
        compilationStatus: CompilationStatus.FAILED,
        compilationError: 'javac failed',
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
      ],
    });

    await expect(
      service.uploadTestSubmission(
        '30000123',
        {},
        {
          buffer: Buffer.from('zip'),
          mimetype: 'application/zip',
          originalname: 'solution.zip',
          size: 3,
        } as Express.Multer.File,
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(httpService.post).not.toHaveBeenCalled();
    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
  });

  it('rate limits rerun scorer task launches in batches', async () => {
    jest.useFakeTimers();

    try {
      const { service, httpService, ecsService, m2mService, prisma } =
        createService();
      const challengeId = '30000123';
      const submissionRows = Array.from({ length: 10 }, (_, index) => ({
        id: `submission-${index + 1}`,
        memberId: `member-${index + 1}`,
        submittedDate: `2026-06-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        isLatest: true,
        virusScan: true,
      }));
      const submissionIds = submissionRows.map((submission) => submission.id);
      const launchResolvers: Array<() => void> = [];

      prisma.marathonMatchConfig.findUnique.mockResolvedValue({
        id: 'config-1',
        challengeId,
        active: true,
        testerId: 'tester-1',
        submissionApiUrl: 'https://submissions.example/v5',
        taskDefinitionName: 'mm-runner',
        taskDefinitionVersion: '7',
        tester: {
          compilationStatus: CompilationStatus.SUCCESS,
          compilationError: null,
        },
        phaseConfigs: [
          {
            id: 'phase-provisional',
            phaseId: 'provisional-phase',
            configType: PhaseConfigType.PROVISIONAL,
            startSeed: BigInt(100),
            numberOfTests: 50,
          },
        ],
      });
      m2mService.getM2MToken.mockResolvedValue('m2m-token');
      httpService.get
        .mockReturnValueOnce(
          of({
            data: {
              status: 'ACTIVE',
              phases: [
                {
                  phaseId: 'provisional-phase',
                  isOpen: true,
                  actualStartDate: '2026-06-01T00:00:00.000Z',
                },
              ],
            },
          }),
        )
        .mockReturnValueOnce(
          of({
            data: {
              result: submissionRows,
            },
            headers: {
              'x-total-pages': '1',
            },
          }),
        );
      ecsService.launchScorerTask.mockImplementation((...args: unknown[]) => {
        const submissionId = String(args[1]);
        return new Promise((resolve) => {
          launchResolvers.push(() =>
            resolve({
              taskArn: `arn:aws:ecs:us-east-1:123456789012:task/${submissionId}`,
              taskId: `task-${submissionId}`,
            }),
          );
        });
      });
      const launchedSubmissionIds = () =>
        ecsService.launchScorerTask.mock.calls.map((call) => String(call[1]));

      const rerunPromise = service.rerunLatestSubmissions(challengeId, {
        isMachine: false,
        userId: '40051399',
      } as never);

      await flushPromises();

      expect(ecsService.launchScorerTask).toHaveBeenCalledTimes(8);
      expect(launchedSubmissionIds()).toEqual(submissionIds.slice(0, 8));

      launchResolvers.splice(0).forEach((resolve) => resolve());
      await flushPromises();
      await jest.advanceTimersByTimeAsync(1099);

      expect(ecsService.launchScorerTask).toHaveBeenCalledTimes(8);

      await jest.advanceTimersByTimeAsync(1);
      await flushPromises();

      expect(ecsService.launchScorerTask).toHaveBeenCalledTimes(10);
      expect(launchedSubmissionIds()).toEqual(submissionIds);

      launchResolvers.splice(0).forEach((resolve) => resolve());

      const result = await rerunPromise;

      expect(result).toEqual({
        challengeId,
        submissionsQueued: 10,
        results: submissionIds.map((submissionId) => ({
          submissionId,
          configType: PhaseConfigType.PROVISIONAL,
          taskArn: `arn:aws:ecs:us-east-1:123456789012:task/${submissionId}`,
          taskId: `task-${submissionId}`,
        })),
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects reruns when currentPhase is closed and no phase is open', async () => {
    const { service, ecsService, httpService, m2mService, prisma } =
      createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      submissionApiUrl: 'https://submissions.example.com/v6',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'provisional-phase',
          startSeed: BigInt(100),
          numberOfTests: 50,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValueOnce(
      of({
        data: {
          status: 'ACTIVE',
          phases: [
            {
              phaseId: 'provisional-phase',
              isOpen: false,
              actualStartDate: '2026-05-01T00:00:00.000Z',
            },
          ],
          currentPhase: {
            phaseId: 'provisional-phase',
            isOpen: false,
          },
        },
      }),
    );

    await expect(
      service.rerunLatestSubmissions('30000123', {
        isMachine: false,
        userId: '40051399',
      } as never),
    ).rejects.toThrow(BadRequestException);

    expect(httpService.get).toHaveBeenCalledTimes(1);
    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
  });

  it('reruns all matching existing system reviews', async () => {
    const { service, httpService, m2mService, prisma, scoringResultService } =
      createService();
    const user = {
      isMachine: false,
      userId: '40051399',
    } as never;

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'config-1',
      challengeId: '30000123',
      active: true,
      reviewScorecardId: 'legacy-scorecard-1',
      testerId: 'tester-1',
      tester: {
        compilationStatus: CompilationStatus.SUCCESS,
      },
      phaseConfigs: [
        {
          id: 'phase-system',
          configType: PhaseConfigType.SYSTEM,
          phaseId: 'system-phase',
          startSeed: BigInt(1000),
          numberOfTests: 5000,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            status: 'ACTIVE',
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            id: 'canonical-scorecard-1',
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            result: {
              content: [
                {
                  id: 'review-2',
                  submissionId: 'submission-2',
                  scorecardId: 'canonical-scorecard-1',
                  status: 'COMPLETED',
                },
                {
                  id: 'review-1',
                  submissionId: 'submission-1',
                  scoreCardId: 'legacy-scorecard-1',
                  status: 'IN_PROGRESS',
                },
                {
                  id: 'review-cancelled',
                  submissionId: 'submission-cancelled',
                  scorecardId: 'canonical-scorecard-1',
                  status: 'CANCELLED',
                },
                {
                  id: 'review-other',
                  submissionId: 'submission-other',
                  scorecardId: 'scorecard-other',
                  status: 'PENDING',
                },
              ],
            },
          },
          headers: {
            'x-total-pages': '1',
          },
        }),
      );
    scoringResultService.triggerSystemScore
      .mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:task/task-1',
        taskId: 'task-1',
      })
      .mockResolvedValueOnce({
        taskArn: 'arn:aws:ecs:task/task-2',
        taskId: 'task-2',
      });

    const result = await service.rerunSystemTests('30000123', user);

    expect(result).toEqual({
      challengeId: '30000123',
      reviewsQueued: 2,
      results: [
        {
          reviewId: 'review-1',
          submissionId: 'submission-1',
          taskArn: 'arn:aws:ecs:task/task-1',
          taskId: 'task-1',
        },
        {
          reviewId: 'review-2',
          submissionId: 'submission-2',
          taskArn: 'arn:aws:ecs:task/task-2',
          taskId: 'task-2',
        },
      ],
    });
    expect(scoringResultService.triggerSystemScore).toHaveBeenCalledTimes(2);
    expect(scoringResultService.triggerSystemScore).toHaveBeenNthCalledWith(
      1,
      'review-1',
      'submission-1',
      '30000123',
    );
    expect(scoringResultService.triggerSystemScore).toHaveBeenNthCalledWith(
      2,
      'review-2',
      'submission-2',
      '30000123',
    );
    expect(httpService.get).toHaveBeenNthCalledWith(
      3,
      'https://api.topcoder-dev.com/v6/reviews',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
        params: {
          challengeId: '30000123',
          page: 1,
          perPage: 100,
          thin: 'true',
        },
      },
    );
  });

  it('normalizes large startSeed strings to BigInt when creating phase configs', async () => {
    const { service, httpService, m2mService, prisma } = createService();
    const maxRangeStartSeed = '9223372036854775800';
    const challengePayload = {
      id: '30000123',
      phases: [
        {
          id: 'challenge-phase-row',
          phaseId: 'submission-phase',
        },
      ],
    };

    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    prisma.tester.findUnique.mockResolvedValue({
      id: 'tester-1',
    });
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<void>) => callback(prisma),
    );
    prisma.marathonMatchConfig.create.mockResolvedValue({});
    prisma.phaseConfig.create.mockResolvedValue({});
    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      id: 'generated-id',
      challengeId: '30000123',
      name: 'MM June 2026 Config',
      active: true,
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      reviewScorecardId: 'scorecard-1',
      testerId: 'tester-1',
      testTimeout: 90000,
      compileTimeout: 120000,
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      createdAt: new Date('2026-03-01T00:00:00.000Z'),
      updatedAt: new Date('2026-03-02T00:00:00.000Z'),
      createdBy: '40051399',
      updatedBy: '40051399',
      phaseConfigs: [
        {
          id: 'phase-provisional',
          configType: PhaseConfigType.PROVISIONAL,
          startSeed: BigInt(maxRangeStartSeed),
          numberOfTests: 8,
          phaseId: 'submission-phase',
          createdAt: new Date('2026-03-01T00:00:00.000Z'),
          updatedAt: new Date('2026-03-02T00:00:00.000Z'),
          marathonMatchConfigId: 'generated-id',
        },
      ],
    });
    httpService.get
      .mockReturnValueOnce(
        of({
          data: challengePayload,
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            id: 'resolved-scorecard-id',
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: challengePayload,
        }),
      );

    const result = await service.createConfig(
      '30000123',
      {
        ...createConfigPayload(),
        provisional: {
          configType: PhaseConfigType.PROVISIONAL,
          phaseId: 'challenge-phase-row',
          startSeed: maxRangeStartSeed,
          numberOfTests: 8,
        },
      },
      {
        isMachine: false,
        userId: '40051399',
      } as never,
    );

    expect(prisma.phaseConfig.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        configType: PhaseConfigType.PROVISIONAL,
        phaseId: 'submission-phase',
        startSeed: BigInt(maxRangeStartSeed),
        numberOfTests: 8,
      }),
    });
    expect(result.provisional?.startSeed).toBe(maxRangeStartSeed);
  });

  it('rejects create requests when challengeId does not resolve', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      throwError(() => ({
        message: 'Request failed with status code 404',
        response: {
          status: 404,
          data: {
            message: 'Challenge not found',
          },
        },
      })),
    );

    await expect(
      service.createConfig(
        '30000999',
        createConfigPayload() as never,
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toThrow(NotFoundException);

    expect(prisma.tester.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/challenges/30000999',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
  });

  it('rejects create requests when reviewScorecardId cannot be resolved', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    prisma.tester.findUnique.mockResolvedValue({
      id: 'tester-1',
    });
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            id: '30000123',
            phases: [],
          },
        }),
      )
      .mockReturnValueOnce(
        throwError(() => ({
          message: 'Request failed with status code 404',
          response: {
            status: 404,
            data: {
              message: 'Scorecard not found',
            },
          },
        })),
      );

    await expect(
      service.createConfig(
        '30000123',
        createConfigPayload() as never,
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toThrow(BadRequestException);

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(httpService.get).toHaveBeenNthCalledWith(
      2,
      'https://api.topcoder-dev.com/v6/scorecards/scorecard-1',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
  });

  it('returns conflict when a config already exists for the challenge', async () => {
    const { service, httpService, m2mService, prisma, prismaErrorService } =
      createService();

    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    prisma.tester.findUnique.mockResolvedValue({
      id: 'tester-1',
    });
    prisma.$transaction.mockImplementation(
      (callback: (tx: typeof prisma) => Promise<void>) => callback(prisma),
    );
    prisma.marathonMatchConfig.create.mockRejectedValue(new Error('duplicate'));
    prismaErrorService.handleError.mockReturnValue({
      message:
        'A record with these unique fields already exists. Please check for duplicates.',
      code: 'UNIQUE_CONSTRAINT_FAILED',
      details: {
        duplicateFields: 'challengeId',
      },
    });
    httpService.get
      .mockReturnValueOnce(
        of({
          data: {
            id: '30000123',
            phases: [],
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            id: 'resolved-scorecard-id',
          },
        }),
      );

    await expect(
      service.createConfig(
        '30000123',
        createConfigPayload() as never,
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toThrow(ConflictException);

    expect(prismaErrorService.handleError).toHaveBeenCalledWith(
      expect.any(Error),
      'creating marathon match config with challenge ID: 30000123',
    );
  });
});
