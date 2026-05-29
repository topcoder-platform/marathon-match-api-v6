import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScoreDirection } from '@prisma/client';
import { of, throwError } from 'rxjs';

jest.mock('src/shared/modules/global/ecs.service', () => ({
  EcsService: class EcsService {},
}));

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import {
  ScoringResultCallbackPayload,
  ScoringResultService,
  ScoringTestStatus,
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
    const payloadWithSeedMetadata: ScoringResultCallbackPayload = {
      ...basePayload,
      metadata: {
        startSeed: '753388858',
        testScores: [
          {
            testcase: '753388858',
            score: 10,
            runTimeMs: 1,
            seed: '753388858',
          },
          {
            testcase: '753388859',
            score: 20,
            runTimeMs: 2,
          },
        ],
      },
    };

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
    const findExistingReviewSummationsSpy = jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    const completeSystemReviewIfNeededSpy = jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    await expect(
      service.processScoringResult(payloadWithSeedMetadata),
    ).resolves.toBe(undefined);

    expect(prisma.marathonMatchConfig.findUnique).toHaveBeenCalledTimes(1);
    expect(m2mService.getM2MToken).toHaveBeenCalledTimes(1);
    expect(createReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        submissionId: payloadWithSeedMetadata.submissionId,
        aggregateScore: payloadWithSeedMetadata.score,
        isPassing: true,
        isProvisional: true,
        metadata: expect.objectContaining({
          reviewTypeId: payloadWithSeedMetadata.reviewTypeId,
          testProgress: 1,
          testStatus: ScoringTestStatus.Success,
          testProcess: 'provisional',
          testType: 'provisional',
        }),
      }),
    );
    const reviewPayload = createReviewSummationSpy.mock.calls[0][1] as {
      metadata: Record<string, unknown>;
    };
    expect(reviewPayload.metadata.startSeed).toBeUndefined();
    expect(reviewPayload.metadata.testScores).toEqual([
      {
        score: 10,
        runTimeMs: 1,
        testcase: '1',
      },
      {
        score: 20,
        runTimeMs: 2,
        testcase: '2',
      },
    ]);
    expect(findExistingReviewSummationsSpy).toHaveBeenCalledWith(
      'm2m-token',
      payloadWithSeedMetadata.submissionId,
      'provisional',
    );
    expect(completeSystemReviewIfNeededSpy).toHaveBeenCalledWith(
      'm2m-token',
      undefined,
      payloadWithSeedMetadata.score,
      'provisional',
      {
        challengeId: payloadWithSeedMetadata.challengeId,
        scorecardId: undefined,
        submissionId: payloadWithSeedMetadata.submissionId,
      },
    );
  });

  it('updates every matching phase review summation so stale progress rows are completed', async () => {
    const { service, m2mService, prisma } = createService();

    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      score: 100,
      testPhase: 'system',
    };

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
    const updateReviewSummationSpy = jest
      .spyOn(service as any, 'updateReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([
        {
          id: 'progress-summation',
          isFinal: true,
          metadata: {
            testStatus: ScoringTestStatus.InProgress,
            testType: 'system',
          },
        },
        {
          id: 'final-summation',
          isFinal: true,
          metadata: {
            testStatus: ScoringTestStatus.Success,
            testType: 'system',
          },
        },
      ]);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    await expect(service.processScoringResult(systemPayload)).resolves.toBe(
      undefined,
    );

    expect(createReviewSummationSpy).not.toHaveBeenCalled();
    expect(updateReviewSummationSpy).toHaveBeenCalledTimes(2);
    expect(updateReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      'progress-summation',
      expect.objectContaining({
        aggregateScore: 100,
        isFinal: true,
        isPassing: true,
        metadata: expect.objectContaining({
          testProgress: 1,
          testStatus: ScoringTestStatus.Success,
          testProcess: 'system',
          testType: 'system',
        }),
      }),
    );
    expect(updateReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      'final-summation',
      expect.objectContaining({
        aggregateScore: 100,
        isFinal: true,
        isPassing: true,
        metadata: expect.objectContaining({
          testStatus: ScoringTestStatus.Success,
        }),
      }),
    );
  });

  it('completes a pending system review found by submission when the callback has no reviewId', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      score: 100,
      scorecardId: 'scorecard-1',
      testPhase: 'system',
    };

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'resolveScorecardId')
      .mockResolvedValue('scorecard-1');
    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);

    httpService.get.mockReturnValue(
      of({
        data: {
          data: [
            {
              id: 'review-1',
              scorecardId: 'scorecard-1',
              status: 'PENDING',
              submissionId: basePayload.submissionId,
            },
          ],
        },
      }),
    );
    httpService.patch.mockReturnValue(of({ data: { id: 'review-1' } }));

    await expect(service.processScoringResult(systemPayload)).resolves.toBe(
      undefined,
    );

    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviews',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
        params: {
          challengeId: basePayload.challengeId,
          perPage: '100',
          submissionId: basePayload.submissionId,
          thin: 'true',
        },
      }),
    );
    expect(httpService.patch).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviews/review-1',
      expect.objectContaining({
        finalScore: 100,
        status: 'COMPLETED',
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
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
    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
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

  it('persists scoring progress as review summation metadata', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    const updateReviewSummationSpy = jest
      .spyOn(service as any, 'updateReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([
        {
          id: 'summation-1',
          metadata: {
            testProcess: 'provisional',
            testType: 'provisional',
          },
        },
      ]);

    await expect(
      service.processScoringProgress({
        challengeId: basePayload.challengeId,
        completedTests: 4,
        failedTests: 0,
        progress: 0.2,
        reviewTypeId: basePayload.reviewTypeId,
        status: ScoringTestStatus.InProgress,
        message: 'Completed seed 753388861',
        submissionId: basePayload.submissionId,
        testPhase: 'provisional',
        totalTests: 20,
      }),
    ).resolves.toBe(undefined);

    expect(updateReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      'summation-1',
      expect.objectContaining({
        aggregateScore: -1,
        isPassing: false,
        isProvisional: true,
        metadata: expect.objectContaining({
          testProgress: 0.2,
          testStatus: ScoringTestStatus.InProgress,
          testProcess: 'provisional',
          testProgressDetails: expect.objectContaining({
            completedTests: 4,
            failedTests: 0,
            message: 'Completed test 4 of 20',
            status: ScoringTestStatus.InProgress,
            testProcess: 'provisional',
            totalTests: 20,
          }),
        }),
      }),
    );
  });

  it('does not award relative scoring credit for zero-score ties', () => {
    const { service } = createService();
    const calculateRelativeScore = (service as any).calculateRelativeScore.bind(
      service,
    ) as (rawScore: number, bestScore?: number) => number;

    expect(calculateRelativeScore(0, 0)).toBe(0);
    expect(calculateRelativeScore(0, 50)).toBe(0);
    expect(calculateRelativeScore(50, 0)).toBe(0);
    expect(calculateRelativeScore(50, 50)).toBe(100);
  });
});
