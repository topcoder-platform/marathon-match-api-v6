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

  const createService = (scoringCompletionEmailService?: {
    sendSubmissionScoringCompleteEmail?: jest.Mock;
    sendSystemScoringCompleteEmail?: jest.Mock;
  }) => {
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
      scoringCompletionEmailService as never,
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
        name: true,
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
      name: 'Blocks',
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
      name: 'Blocks',
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

  it('sends scoring completion email after example and provisional summations are both complete', async () => {
    const scoringCompletionEmailService = {
      sendSubmissionScoringCompleteEmail: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const { service, httpService, m2mService, prisma } = createService(
      scoringCompletionEmailService,
    );

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Marathon Match Scorer',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    httpService.get
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: basePayload.submissionId,
              memberHandle: 'competitor',
              reviewSummation: [
                {
                  aggregateScore: 96,
                  isExample: true,
                  metadata: {
                    testProgress: 1,
                    testStatus: ScoringTestStatus.Success,
                    testType: 'example',
                  },
                },
                {
                  aggregateScore: 88,
                  isProvisional: true,
                  metadata: {
                    testProgress: 1,
                    testStatus: ScoringTestStatus.Success,
                    testType: 'provisional',
                  },
                },
              ],
            },
          ],
          headers: {},
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            result: {
              content: {
                name: 'Marathon Match 2026 Beta Test',
              },
            },
          },
        }),
      );

    await expect(service.processScoringResult(basePayload)).resolves.toBe(
      undefined,
    );

    expect(
      scoringCompletionEmailService.sendSubmissionScoringCompleteEmail,
    ).toHaveBeenCalledWith('m2m-token', {
      aggregateExampleScore: 96,
      aggregateProvisionalScore: 88,
      challengeId: basePayload.challengeId,
      challengeName: 'Marathon Match 2026 Beta Test',
      memberHandle: 'competitor',
      scoringStatus: 'pass',
      submissionId: basePayload.submissionId,
    });
  });

  it('uses the submission ID to resolve member ID when the listed submission has no handle', async () => {
    const scoringCompletionEmailService = {
      sendSubmissionScoringCompleteEmail: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const { service, httpService, m2mService, prisma } = createService(
      scoringCompletionEmailService,
    );

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    httpService.get
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: basePayload.submissionId,
              reviewSummation: [
                {
                  aggregateScore: 96,
                  isExample: true,
                  metadata: {
                    testProgress: 1,
                    testStatus: ScoringTestStatus.Success,
                    testType: 'example',
                  },
                },
                {
                  aggregateScore: 88,
                  isProvisional: true,
                  metadata: {
                    testProgress: 1,
                    testStatus: ScoringTestStatus.Success,
                    testType: 'provisional',
                  },
                },
              ],
            },
          ],
          headers: {},
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            id: basePayload.submissionId,
            memberId: '123456',
          },
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            name: 'Blocks',
          },
        }),
      );

    await expect(service.processScoringResult(basePayload)).resolves.toBe(
      undefined,
    );

    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/submissions/submission-1',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
    expect(
      scoringCompletionEmailService.sendSubmissionScoringCompleteEmail,
    ).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        memberId: '123456',
        userId: '123456',
      }),
    );
  });

  it('marks scoring completion email status as fail when a completed phase failed', async () => {
    const scoringCompletionEmailService = {
      sendSubmissionScoringCompleteEmail: jest
        .fn()
        .mockResolvedValue(undefined),
    };
    const { service, httpService, m2mService, prisma } = createService(
      scoringCompletionEmailService,
    );

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    httpService.get.mockReturnValue(
      of({
        data: [
          {
            id: basePayload.submissionId,
            memberHandle: 'competitor',
            reviewSummation: [
              {
                aggregateScore: 96,
                isExample: true,
                isPassing: true,
                metadata: {
                  testProgress: 1,
                  testStatus: ScoringTestStatus.Success,
                  testType: 'example',
                },
              },
              {
                aggregateScore: -1,
                isPassing: false,
                isProvisional: true,
                metadata: {
                  testProgress: 1,
                  testStatus: ScoringTestStatus.Failed,
                  testType: 'provisional',
                },
              },
            ],
          },
        ],
        headers: {},
      }),
    );

    await expect(service.processScoringResult(basePayload)).resolves.toBe(
      undefined,
    );

    expect(
      scoringCompletionEmailService.sendSubmissionScoringCompleteEmail,
    ).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        aggregateExampleScore: 96,
        aggregateProvisionalScore: -1,
        scoringStatus: 'fail',
      }),
    );
  });

  it('skips system scoring emails until all latest member summations are complete', async () => {
    const scoringCompletionEmailService = {
      sendSystemScoringCompleteEmail: jest.fn().mockResolvedValue(undefined),
    };
    const { service, httpService, m2mService, prisma } = createService(
      scoringCompletionEmailService,
    );
    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      score: -1,
      testPhase: 'system',
    };

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    httpService.get.mockReturnValue(
      of({
        data: [
          {
            id: basePayload.submissionId,
            memberId: 'member-1',
            memberHandle: 'competitor',
            submittedDate: '2026-05-01T00:00:00.000Z',
            reviewSummation: [
              {
                aggregateScore: -1,
                isFinal: true,
                isPassing: false,
                metadata: {
                  testProgress: 1,
                  testStatus: ScoringTestStatus.Failed,
                  testType: 'system',
                },
              },
            ],
          },
          {
            id: 'submission-2',
            memberId: 'member-2',
            memberHandle: 'second',
            submittedDate: '2026-05-01T00:00:01.000Z',
            reviewSummation: [
              {
                aggregateScore: 90,
                isFinal: true,
                metadata: {
                  testProgress: 0.5,
                  testStatus: ScoringTestStatus.InProgress,
                  testType: 'system',
                },
              },
            ],
          },
        ],
        headers: {},
      }),
    );

    await expect(service.processScoringResult(systemPayload)).resolves.toBe(
      undefined,
    );

    expect(
      scoringCompletionEmailService.sendSystemScoringCompleteEmail,
    ).not.toHaveBeenCalled();
  });

  it('sends system scoring emails with placements after all latest member summations are complete', async () => {
    const scoringCompletionEmailService = {
      sendSystemScoringCompleteEmail: jest.fn().mockResolvedValue(undefined),
    };
    const { service, httpService, m2mService, prisma } = createService(
      scoringCompletionEmailService,
    );
    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      score: -1,
      testPhase: 'system',
    };

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    httpService.get.mockReturnValue(
      of({
        data: [
          {
            id: basePayload.submissionId,
            memberId: 'member-1',
            memberHandle: 'competitor',
            submittedDate: '2026-05-01T00:00:00.000Z',
            reviewSummation: [
              {
                aggregateScore: -1,
                isFinal: true,
                isPassing: false,
                metadata: {
                  testProgress: 1,
                  testStatus: ScoringTestStatus.Failed,
                  testType: 'system',
                },
              },
            ],
          },
          {
            id: 'submission-2',
            memberId: 'member-2',
            memberHandle: 'second',
            submittedDate: '2026-05-01T00:00:01.000Z',
            reviewSummation: [
              {
                aggregateScore: 90,
                isFinal: true,
                isPassing: true,
                metadata: {
                  testProgress: 1,
                  testStatus: ScoringTestStatus.Success,
                  testType: 'system',
                },
              },
            ],
          },
        ],
        headers: {},
      }),
    );

    await expect(service.processScoringResult(systemPayload)).resolves.toBe(
      undefined,
    );

    expect(
      scoringCompletionEmailService.sendSystemScoringCompleteEmail,
    ).toHaveBeenCalledTimes(2);
    expect(
      scoringCompletionEmailService.sendSystemScoringCompleteEmail,
    ).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        challengeId: basePayload.challengeId,
        challengeName: 'Blocks',
        finalSystemScore: 90,
        memberHandle: 'second',
        placement: '1st',
        scoringStatus: 'pass',
        submissionId: 'submission-2',
      }),
    );
    expect(
      scoringCompletionEmailService.sendSystemScoringCompleteEmail,
    ).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        challengeId: basePayload.challengeId,
        challengeName: 'Blocks',
        finalSystemScore: -1,
        memberHandle: 'competitor',
        placement: '2nd',
        scoringStatus: 'fail',
        submissionId: basePayload.submissionId,
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
      name: 'Blocks',
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
      name: 'Blocks',
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

  it('persists in-progress scoring progress without a failed placeholder score', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
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
        aggregateScore: 0,
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

  it('persists failed scoring progress with a failed placeholder score', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
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
        failedTests: 1,
        progress: 0.2,
        reviewTypeId: basePayload.reviewTypeId,
        status: ScoringTestStatus.Failed,
        message: 'Runner failed',
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
        metadata: expect.objectContaining({
          testStatus: ScoringTestStatus.Failed,
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

  it('selects the latest relative review using current submission date fields when created is missing', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberId?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          id: 'newer-submission',
          memberId: 'member-1',
          submittedDate: '2026-05-28T15:23:32.877Z',
          createdAt: '2026-05-28T15:23:32.878Z',
          reviewSummation: [
            {
              id: 'newer-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
              },
            },
          ],
        },
        {
          id: 'older-submission',
          memberId: 'member-1',
          submittedDate: '2026-05-28T15:21:12.605Z',
          createdAt: '2026-05-28T15:21:12.606Z',
          reviewSummation: [
            {
              id: 'older-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 10 }],
              },
            },
          ],
        },
      ],
      'provisional',
      basePayload.reviewTypeId,
      'current-submission',
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        submissionId: 'newer-submission',
        rawTestScores: [expect.objectContaining({ score: 100 })],
      }),
    );
  });

  it('does not let an older no-testScores summation drop a newer valid relative review', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberId?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          id: 'newer-valid-submission',
          memberId: 'member-1',
          submittedDate: '2026-05-28T15:23:32.877Z',
          createdAt: '2026-05-28T15:23:32.878Z',
          reviewSummation: [
            {
              id: 'newer-valid-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
              },
            },
          ],
        },
        {
          id: 'older-failed-submission',
          memberId: 'member-1',
          submittedDate: '2026-05-28T15:21:12.605Z',
          createdAt: '2026-05-28T15:21:12.606Z',
          reviewSummation: [
            {
              id: 'older-failed-review',
              aggregateScore: -1,
              isProvisional: true,
              metadata: {
                testStatus: ScoringTestStatus.Failed,
                testType: 'provisional',
              },
            },
          ],
        },
      ],
      'provisional',
      basePayload.reviewTypeId,
      'current-submission',
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        submissionId: 'newer-valid-submission',
        rawTestScores: [expect.objectContaining({ score: 100 })],
      }),
    );
  });
});
