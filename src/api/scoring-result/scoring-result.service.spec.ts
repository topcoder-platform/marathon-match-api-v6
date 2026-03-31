import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScoreDirection } from '@prisma/client';
import { throwError } from 'rxjs';

jest.mock('src/shared/modules/global/ecs.service', () => ({
  EcsService: class EcsService {},
}));

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import {
  ScoringResultCallbackPayload,
  ScoringResultService,
} from './scoring-result.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';

describe('ScoringResultService', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const basePayload: ScoringResultCallbackPayload = {
    challengeId: '30000123',
    submissionId: 'submission-1',
    score: 88,
    testPhase: 'test',
    reviewTypeId: 'review-type-1',
  };

  const createService = () => {
    const httpService = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
    };
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const prisma = {
      marathonMatchConfig: {
        findUnique: jest.fn(),
      },
    };
    const ecsService = {};

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new ScoringResultService(
      httpService as never,
      m2mService as never,
      prisma as never,
      ecsService as never,
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

  it('rejects scorer callbacks when the challengeId has no Marathon Match config', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue(null);

    await expect(service.processScoringResult(basePayload)).rejects.toThrow(
      NotFoundException,
    );

    expect(prisma.marathonMatchConfig.findUnique).toHaveBeenCalledWith({
      where: { challengeId: basePayload.challengeId },
      select: {
        challengeId: true,
        submissionApiUrl: true,
        relativeScoringEnabled: true,
        scoreDirection: true,
      },
    });
    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
  });

  it('accepts scorer callbacks for configured challenges and persists the review summation', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    const createReviewSummationSpy = jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    const completeSystemReviewIfNeededSpy = jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    await expect(service.processScoringResult(basePayload)).resolves.toBe(
      undefined,
    );

    expect(prisma.marathonMatchConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(createReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        submissionId: basePayload.submissionId,
        aggregateScore: basePayload.score,
        isPassing: true,
        isProvisional: true,
        metadata: expect.objectContaining({
          reviewTypeId: basePayload.reviewTypeId,
          testType: 'provisional',
        }),
      }),
    );
    expect(completeSystemReviewIfNeededSpy).toHaveBeenCalledWith(
      'm2m-token',
      undefined,
      basePayload.score,
      'provisional',
    );
  });

  it('returns a bad request error when review-api rejects a nonexistent submissionId', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.post.mockReturnValue(
      throwError(() => ({
        response: {
          status: 404,
          data: {
            message: `Submission ${basePayload.submissionId} not found.`,
          },
        },
      })),
    );

    let thrownError: unknown;
    try {
      await service.processScoringResult(basePayload);
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(BadRequestException);
    expect((thrownError as BadRequestException).message).toBe(
      `Failed to create review summation: HTTP 404: Submission ${basePayload.submissionId} not found.`,
    );
  });
});
