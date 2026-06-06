import {
  BadRequestException,
  ConflictException,
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

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new MarathonMatchConfigService(
      httpService as never,
      ecsService as never,
      m2mService as never,
      prisma as never,
      prismaErrorService as never,
    );

    return {
      service,
      ecsService,
      httpService,
      m2mService,
      prisma,
      prismaErrorService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
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
    );
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
