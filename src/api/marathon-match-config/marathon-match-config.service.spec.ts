import { of } from 'rxjs';
import { PhaseConfigType, ScoreDirection } from '@prisma/client';
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
    const ecsService = {};
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const prisma = {
      marathonMatchConfig: {
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
      httpService,
      m2mService,
      prisma,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
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
          startSeed: 100,
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
});
