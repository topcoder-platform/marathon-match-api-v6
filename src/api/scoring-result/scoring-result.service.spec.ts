import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ScoreDirection } from '@prisma/client';
import { of, throwError } from 'rxjs';

type MockPgClient = {
  connect: jest.Mock;
  query: jest.Mock;
  end: jest.Mock;
};

jest.mock('pg', () => ({
  Client: (() => {
    const clients: MockPgClient[] = [];
    const Client = jest.fn().mockImplementation(() => {
      const client = {
        connect: jest.fn().mockResolvedValue(undefined),
        query: jest.fn().mockResolvedValue({ rows: [{ unlocked: true }] }),
        end: jest.fn().mockResolvedValue(undefined),
      };
      clients.push(client);
      return client;
    });
    (Client as any).clients = clients;
    return Client;
  })(),
}));

jest.mock('src/shared/modules/global/ecs.service', () => ({
  EcsService: class EcsService {},
}));

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { Client as PgClient } from 'pg';
import {
  ScoringResultCallbackPayload,
  ScoringResultService,
  ScoringTestStatus,
} from './scoring-result.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';

const mockPgClientConstructor = PgClient as unknown as jest.Mock & {
  clients: MockPgClient[];
};
const mockPgClients = mockPgClientConstructor.clients;

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
  const originalDatabaseUrl = process.env.DATABASE_URL;

  const createService = (
    scoringCompletionEmailService?: {
      sendSubmissionScoringCompleteEmail?: jest.Mock;
      sendSystemScoringCompleteEmail?: jest.Mock;
    },
    systemTestTimeoutSchedulerService?: {
      scheduleSystemTestTimeout?: jest.Mock;
    },
  ) => {
    const httpService = {
      get: jest.fn(),
      post: jest.fn(),
      put: jest.fn(),
      patch: jest.fn(),
    };
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const prisma: {
      $executeRaw: jest.Mock;
      $queryRaw: jest.Mock;
      $transaction: jest.Mock;
      marathonMatchConfig: {
        findUnique: jest.Mock;
      };
      testSubmissionRun: {
        findFirst: jest.Mock;
        update: jest.Mock;
      };
    } = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn().mockResolvedValue([]),
      $transaction: jest.fn(),
      marathonMatchConfig: {
        findUnique: jest.fn(),
      },
      testSubmissionRun: {
        findFirst: jest.fn(),
        update: jest.fn(),
      },
    };
    prisma.$transaction.mockImplementation(
      async (callback: (client: typeof prisma) => Promise<unknown>) =>
        callback(prisma),
    );
    const ecsService = {
      launchScorerTask: jest.fn(),
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new ScoringResultService(
      httpService as never,
      m2mService as never,
      prisma as never,
      ecsService as never,
      scoringCompletionEmailService as never,
      systemTestTimeoutSchedulerService as never,
    );

    return {
      service,
      httpService,
      m2mService,
      prisma,
      ecsService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL =
      'postgresql://postgres:postgres@localhost:5432/test';
    mockPgClients.length = 0;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(() => {
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
      return;
    }

    process.env.DATABASE_URL = originalDatabaseUrl;
  });

  const flushAsyncWork = () =>
    new Promise<void>((resolve) => setImmediate(resolve));

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['above Long.MAX_VALUE', 1e29],
  ])(
    'rejects scorer callbacks with invalid %s scores before writing summations',
    async (_label, score) => {
      const { service, m2mService, prisma } = createService();

      await expect(
        service.processScoringResult({
          ...basePayload,
          score,
        }),
      ).rejects.toThrow(BadRequestException);

      expect(prisma.marathonMatchConfig.findUnique).not.toHaveBeenCalled();
      expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    },
  );

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

  it('stores validation scorer callbacks without writing review summations', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    prisma.testSubmissionRun.findFirst.mockResolvedValue({
      id: 'validation-run-1',
    });

    await expect(
      service.processScoringResult({
        ...basePayload,
        metadata: {
          numberOfTests: 2,
          testScores: [
            {
              score: 88,
              testcase: '1',
            },
          ],
        },
        validationRunId: 'validation-run-1',
      }),
    ).resolves.toBe(undefined);

    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(prisma.testSubmissionRun.update).toHaveBeenCalledWith({
      where: { id: 'validation-run-1' },
      data: expect.objectContaining({
        status: ScoringTestStatus.Success,
        score: 88,
        progress: 1,
        completedTests: 1,
        totalTests: 2,
        failedTests: 0,
        completedAt: expect.any(Date),
      }),
    });
  });

  it('stores validation scorer progress without writing review summations', async () => {
    const { service, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    prisma.testSubmissionRun.findFirst.mockResolvedValue({
      id: 'validation-run-1',
    });

    await expect(
      service.processScoringProgress({
        challengeId: basePayload.challengeId,
        completedTests: 1,
        failedTests: 0,
        progress: 0.5,
        reviewTypeId: basePayload.reviewTypeId,
        status: ScoringTestStatus.InProgress,
        submissionId: 'validation-run-1',
        testPhase: 'provisional',
        totalTests: 2,
        validationRunId: 'validation-run-1',
      }),
    ).resolves.toBe(undefined);

    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(prisma.testSubmissionRun.update).toHaveBeenCalledWith({
      where: { id: 'validation-run-1' },
      data: expect.objectContaining({
        status: ScoringTestStatus.InProgress,
        progress: 0.5,
        completedTests: 1,
        totalTests: 2,
        failedTests: 0,
      }),
    });
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

  it('keeps completed scoring successful when all individual tests fail', async () => {
    const { service, m2mService, prisma } = createService();
    const payloadWithFailedSeed: ScoringResultCallbackPayload = {
      ...basePayload,
      score: -1,
      metadata: {
        numberOfTests: 2,
        testScores: [
          {
            error: 'Timed out.',
            score: -1,
            testcase: '753388858',
          },
          {
            error: 'Crashed.',
            score: -1,
            testcase: '753388859',
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
    jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    await expect(
      service.processScoringResult(payloadWithFailedSeed),
    ).resolves.toBe(undefined);

    expect(createReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        aggregateScore: payloadWithFailedSeed.score,
        isPassing: false,
        metadata: expect.objectContaining({
          testProgress: 1,
          testStatus: ScoringTestStatus.Success,
          testProgressDetails: expect.objectContaining({
            failedTests: 2,
            status: ScoringTestStatus.Success,
          }),
        }),
      }),
    );
  });

  it('persists finite relative scores when the maximize best testcase score is zero', async () => {
    const { service, m2mService, prisma } = createService();
    const zeroScorePayload: ScoringResultCallbackPayload = {
      ...basePayload,
      score: 0,
      testPhase: 'provisional',
      metadata: {
        testScores: [
          { testcase: '753388858', score: 0 },
          { testcase: '753388859', score: 0 },
        ],
      },
    };

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    jest.spyOn(service as any, 'fetchChallengeSubmissions').mockResolvedValue([
      {
        id: 'submission-2',
        memberId: 'member-2',
        submittedDate: '2026-05-01T00:00:00.000Z',
        reviewSummation: [
          {
            id: 'summation-2',
            isProvisional: true,
            metadata: {
              testType: 'provisional',
              testScores: [
                { testcase: '1', score: 0 },
                { testcase: '2', score: 0 },
              ],
            },
          },
        ],
      },
      {
        id: zeroScorePayload.submissionId,
        memberId: 'member-1',
        submittedDate: '2026-05-01T00:00:01.000Z',
        reviewSummation: [],
      },
    ]);
    const upsertReviewSummationSpy = jest
      .spyOn(service as any, 'upsertReviewSummation')
      .mockResolvedValue(undefined);
    const completeSystemReviewIfNeededSpy = jest
      .spyOn(service as any, 'completeSystemReviewIfNeeded')
      .mockResolvedValue(undefined);

    await expect(service.processScoringResult(zeroScorePayload)).resolves.toBe(
      undefined,
    );

    expect(upsertReviewSummationSpy).toHaveBeenCalledTimes(2);
    const payloads = upsertReviewSummationSpy.mock.calls.map(
      (call) => call[2],
    ) as Array<{
      aggregateScore: number;
      metadata: {
        relativeScores: Array<{ testcase: string; score: number }>;
      };
    }>;
    for (const payload of payloads) {
      expect(Number.isFinite(payload.aggregateScore)).toBe(true);
      expect(payload.aggregateScore).toBe(0);
      expect(payload.metadata.relativeScores).toEqual([
        { testcase: '1', score: 0 },
        { testcase: '2', score: 0 },
      ]);
    }
    expect(completeSystemReviewIfNeededSpy).toHaveBeenCalledWith(
      'm2m-token',
      undefined,
      0,
      'provisional',
      {
        challengeId: zeroScorePayload.challengeId,
        scorecardId: undefined,
        submissionId: zeroScorePayload.submissionId,
      },
    );
  });

  it('serializes concurrent relative scoring recomputations for the same challenge phase', async () => {
    const { service, m2mService, prisma } = createService();
    const firstPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      submissionId: 'submission-a',
      score: 90,
      currentReview: {
        metadata: {
          testScores: [{ testcase: '753388858', score: 90 }],
        },
      },
    };
    const secondPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      submissionId: 'submission-b',
      score: 85,
      currentReview: {
        metadata: {
          testScores: [{ testcase: '753388858', score: 85 }],
        },
      },
    };
    let lockChain = Promise.resolve();
    let resolveFirstWriteStarted!: () => void;
    let releaseFirstWrite!: () => void;
    const firstWriteStarted = new Promise<void>((resolve) => {
      resolveFirstWriteStarted = resolve;
    });
    const firstWriteCanFinish = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    const withRelativeScoringLockSpy = jest
      .spyOn(service as any, 'withRelativeScoringLock')
      .mockImplementation(
        (
          _challengeId: string,
          _testPhase: string,
          work: () => Promise<unknown>,
        ) => {
          const run = lockChain.catch(() => undefined).then(() => work());
          lockChain = run.then(
            () => undefined,
            () => undefined,
          );
          return run;
        },
      );
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    const fetchChallengeSubmissionsSpy = jest
      .spyOn(service as any, 'fetchChallengeSubmissions')
      .mockResolvedValueOnce([
        {
          id: 'submission-a',
          memberId: 'member-a',
          submittedDate: '2026-05-01T00:00:00.000Z',
          reviewSummation: [],
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'submission-a',
          memberId: 'member-a',
          submittedDate: '2026-05-01T00:00:00.000Z',
          reviewSummation: [
            {
              id: 'review-a',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '1', score: 90 }],
              },
            },
          ],
        },
        {
          id: 'submission-b',
          memberId: 'member-b',
          submittedDate: '2026-05-01T00:00:01.000Z',
          reviewSummation: [],
        },
      ]);
    const upsertReviewSummationSpy = jest
      .spyOn(service as any, 'upsertReviewSummation')
      .mockImplementationOnce(async () => {
        resolveFirstWriteStarted();
        await firstWriteCanFinish;
      })
      .mockResolvedValue(undefined);

    const firstResult = service.processScoringResult(firstPayload);
    await firstWriteStarted;

    const secondResult = service.processScoringResult(secondPayload);
    await flushAsyncWork();

    expect(fetchChallengeSubmissionsSpy).toHaveBeenCalledTimes(1);

    releaseFirstWrite();
    await expect(Promise.all([firstResult, secondResult])).resolves.toEqual([
      undefined,
      undefined,
    ]);

    expect(withRelativeScoringLockSpy).toHaveBeenCalledTimes(2);
    expect(withRelativeScoringLockSpy.mock.calls[0][0]).toBe(
      basePayload.challengeId,
    );
    expect(withRelativeScoringLockSpy.mock.calls[0][1]).toBe('provisional');
    expect(withRelativeScoringLockSpy.mock.calls[1][0]).toBe(
      basePayload.challengeId,
    );
    expect(withRelativeScoringLockSpy.mock.calls[1][1]).toBe('provisional');
    expect(fetchChallengeSubmissionsSpy).toHaveBeenCalledTimes(2);
    expect(upsertReviewSummationSpy).toHaveBeenCalledTimes(3);

    const secondSubmissionPayload = upsertReviewSummationSpy.mock
      .calls[2][2] as
      | { aggregateScore: number; submissionId: string }
      | undefined;

    expect(secondSubmissionPayload).toEqual(
      expect.objectContaining({
        submissionId: 'submission-b',
      }),
    );
    expect(secondSubmissionPayload?.aggregateScore).toBeCloseTo(
      (85 / 90) * 100,
      10,
    );
  });

  it('holds relative scoring locks with a dedicated PostgreSQL session instead of a Prisma transaction', async () => {
    const { service, prisma } = createService();
    const lockResult = await (service as any).withRelativeScoringLock(
      basePayload.challengeId,
      'system',
      () => Promise.resolve('locked-work-result'),
    );

    expect(lockResult).toBe('locked-work-result');
    expect(mockPgClientConstructor).toHaveBeenCalledWith({
      connectionString: process.env.DATABASE_URL,
    });
    expect(mockPgClients).toHaveLength(1);

    const lockClient = mockPgClients[0];
    expect(lockClient.connect).toHaveBeenCalledTimes(1);
    expect(lockClient.query).toHaveBeenCalledTimes(2);
    expect(lockClient.query.mock.calls[0][0]).toBe(
      'SELECT pg_advisory_lock($1::integer, $2::integer)',
    );
    expect(lockClient.query.mock.calls[1][0]).toBe(
      'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
    );
    expect(lockClient.query.mock.calls[1][1]).toEqual(
      lockClient.query.mock.calls[0][1],
    );
    expect(lockClient.end).toHaveBeenCalledTimes(1);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('closes the relative scoring lock client when locked work fails', async () => {
    const { service } = createService();

    await expect(
      (service as any).withRelativeScoringLock(
        basePayload.challengeId,
        'system',
        () => Promise.reject(new Error('relative scoring failed')),
      ),
    ).rejects.toThrow('relative scoring failed');

    const lockClient = mockPgClients[0];
    expect(lockClient.query.mock.calls[0][0]).toBe(
      'SELECT pg_advisory_lock($1::integer, $2::integer)',
    );
    expect(lockClient.query.mock.calls[1][0]).toBe(
      'SELECT pg_advisory_unlock($1::integer, $2::integer) AS unlocked',
    );
    expect(lockClient.end).toHaveBeenCalledTimes(1);
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

  it('persists system summation before completing the review', async () => {
    const { service, httpService, m2mService, prisma } = createService();
    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      reviewId: 'review-1',
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

    const findExistingReviewSummationsSpy = jest
      .spyOn(service as any, 'findExistingReviewSummations')
      .mockResolvedValue([]);
    const createReviewSummationSpy = jest
      .spyOn(service as any, 'createReviewSummation')
      .mockResolvedValue(undefined);
    const updateReviewSummationSpy = jest
      .spyOn(service as any, 'updateReviewSummation')
      .mockResolvedValue(undefined);

    httpService.get.mockReturnValue(
      of({
        data: {
          data: [],
        },
      }),
    );
    httpService.patch.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: {
            message: 'Review API unavailable',
          },
        },
      })),
    );

    await expect(service.processScoringResult(systemPayload)).rejects.toThrow(
      'Failed to mark review review-1 as COMPLETED: HTTP 503: Review API unavailable',
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
    expect(findExistingReviewSummationsSpy).toHaveBeenCalledWith(
      'm2m-token',
      systemPayload.submissionId,
      'system',
    );
    expect(createReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        aggregateScore: 100,
        isFinal: true,
        submissionId: systemPayload.submissionId,
      }),
    );
    expect(updateReviewSummationSpy).not.toHaveBeenCalled();
    expect(createReviewSummationSpy.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.patch.mock.invocationCallOrder[0],
    );
  });

  it('persists currentReview summation before completing the review', async () => {
    const { service, httpService, m2mService, prisma } = createService();
    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      currentReview: {
        aggregateScore: 97,
      },
      reviewId: 'review-1',
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

    const upsertFromLegacyReviewPayloadSpy = jest
      .spyOn(service as any, 'upsertFromLegacyReviewPayload')
      .mockResolvedValue(97);

    httpService.get.mockReturnValue(
      of({
        data: {
          data: [],
        },
      }),
    );
    httpService.patch.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: {
            message: 'Review API unavailable',
          },
        },
      })),
    );

    await expect(service.processScoringResult(systemPayload)).rejects.toThrow(
      'Failed to mark review review-1 as COMPLETED: HTTP 503: Review API unavailable',
    );

    expect(httpService.patch).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviews/review-1',
      expect.objectContaining({
        finalScore: 97,
        status: 'COMPLETED',
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
    expect(upsertFromLegacyReviewPayloadSpy).toHaveBeenCalledWith(
      'm2m-token',
      expect.objectContaining({
        fallbackScore: 100,
        fallbackSubmissionId: systemPayload.submissionId,
        legacyReview: systemPayload.currentReview,
        testPhase: 'system',
      }),
    );
    expect(
      upsertFromLegacyReviewPayloadSpy.mock.invocationCallOrder[0],
    ).toBeLessThan(httpService.patch.mock.invocationCallOrder[0]);
  });

  it('persists relative summations before completing the review', async () => {
    const { service, httpService, m2mService, prisma } = createService();
    const systemPayload: ScoringResultCallbackPayload = {
      ...basePayload,
      metadata: {
        testScores: [
          {
            testcase: '753388858',
            score: 50,
          },
        ],
      },
      reviewId: 'review-1',
      score: 50,
      testPhase: 'system',
    };

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Blocks',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: true,
      scoreDirection: ScoreDirection.MAXIMIZE,
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');

    const upsertReviewSummationSpy = jest
      .spyOn(service as any, 'upsertReviewSummation')
      .mockResolvedValue(undefined);

    httpService.get
      .mockReturnValueOnce(
        of({
          data: [
            {
              id: basePayload.submissionId,
              memberId: 'member-1',
              submittedDate: '2026-05-01T00:00:00.000Z',
            },
          ],
          headers: {},
        }),
      )
      .mockReturnValueOnce(
        of({
          data: {
            data: [],
          },
        }),
      );
    httpService.patch.mockReturnValue(
      throwError(() => ({
        response: {
          status: 503,
          data: {
            message: 'Review API unavailable',
          },
        },
      })),
    );

    await expect(service.processScoringResult(systemPayload)).rejects.toThrow(
      'Failed to mark review review-1 as COMPLETED: HTTP 503: Review API unavailable',
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
    expect(upsertReviewSummationSpy).toHaveBeenCalledWith(
      'm2m-token',
      'system',
      expect.objectContaining({
        aggregateScore: 100,
        isFinal: true,
        submissionId: systemPayload.submissionId,
      }),
      undefined,
    );
    expect(upsertReviewSummationSpy.mock.invocationCallOrder[0]).toBeLessThan(
      httpService.patch.mock.invocationCallOrder[0],
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

  it('keeps the failed score sentinel for failed scoring progress', async () => {
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
        message: 'Seed 753388861 failed',
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
          testStatus: ScoringTestStatus.Failed,
        }),
      }),
    );
  });

  it('preserves reviewedDate for impacted relative review payloads', () => {
    const { service } = createService();
    const buildRelativeReviewPayload = (
      service as any
    ).buildRelativeReviewPayload.bind(service) as (
      reviewRecord: {
        submissionId: string;
        reviewObject: Record<string, unknown>;
        metadata: Record<string, unknown>;
        rawTestScores: Array<{ testcase: string; score: number }>;
      },
      bestScores: Map<string, number>,
      scoreDirection: ScoreDirection,
      fallbackScorecardId: string | undefined,
      testPhase: string,
      preserveReviewedDate: boolean,
    ) => { payload: { reviewedDate: string } };
    const reviewedDate = '2026-05-28T15:21:12.605Z';

    const result = buildRelativeReviewPayload(
      {
        submissionId: 'impacted-submission',
        reviewObject: {
          id: 'review-summation-1',
          isProvisional: true,
          reviewedDate,
        },
        metadata: {
          testScores: [{ testcase: '753388858', score: 10 }],
          testType: 'provisional',
        },
        rawTestScores: [{ testcase: '753388858', score: 10 }],
      },
      new Map([['753388858', 20]]),
      ScoreDirection.MAXIMIZE,
      undefined,
      'provisional',
      true,
    );

    expect(result.payload.reviewedDate).toBe(reviewedDate);
  });

  it('keeps relative scoring status successful when all individual tests fail', () => {
    const { service } = createService();
    const buildRelativeReviewPayload = (
      service as any
    ).buildRelativeReviewPayload.bind(service) as (
      reviewRecord: {
        submissionId: string;
        reviewObject: Record<string, unknown>;
        metadata: Record<string, unknown>;
        rawTestScores: Array<{
          error?: string;
          score: number;
          testcase: string;
        }>;
      },
      bestScores: Map<string, number>,
      scoreDirection: ScoreDirection,
      fallbackScorecardId: string | undefined,
      testPhase: string,
    ) => {
      payload: {
        aggregateScore: number;
        metadata: {
          testProgressDetails: {
            failedTests: number;
            status: ScoringTestStatus;
          };
          testStatus: ScoringTestStatus;
        };
      };
    };

    const result = buildRelativeReviewPayload(
      {
        submissionId: 'failed-testcase-submission',
        reviewObject: {
          id: 'review-summation-1',
          isProvisional: true,
        },
        metadata: {
          testScores: [
            { error: 'Timed out.', score: -1, testcase: '1' },
            { error: 'Crashed.', score: -1, testcase: '2' },
          ],
          testType: 'provisional',
        },
        rawTestScores: [
          { error: 'Timed out.', score: -1, testcase: '1' },
          { error: 'Crashed.', score: -1, testcase: '2' },
        ],
      },
      new Map(),
      ScoreDirection.MAXIMIZE,
      undefined,
      'provisional',
    );

    expect(result.payload.aggregateScore).toBe(-1);
    expect(result.payload.metadata.testStatus).toBe(ScoringTestStatus.Success);
    expect(result.payload.metadata.testProgressDetails).toEqual(
      expect.objectContaining({
        failedTests: 2,
        status: ScoringTestStatus.Success,
      }),
    );
  });

  it('marks timed-out system tests as failed with timed_out metadata', async () => {
    const { service } = createService();
    const processScoringResultSpy = jest
      .spyOn(service, 'processScoringResult')
      .mockResolvedValue(undefined);

    await expect(
      service.markSystemTestTimedOut({
        challengeId: basePayload.challengeId,
        submissionId: basePayload.submissionId,
        reviewId: 'review-1',
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
        cluster: 'cluster',
        testPhase: 'system',
        reviewTypeId: basePayload.reviewTypeId,
        scorecardId: 'scorecard-1',
        timeoutMs: 86400000,
        launchedAt: '2026-06-09T00:00:00.000Z',
      }),
    ).resolves.toBe(undefined);

    expect(processScoringResultSpy).toHaveBeenCalledWith({
      challengeId: basePayload.challengeId,
      submissionId: basePayload.submissionId,
      score: -1,
      testPhase: 'system',
      reviewTypeId: basePayload.reviewTypeId,
      reviewId: 'review-1',
      scorecardId: 'scorecard-1',
      metadata: expect.objectContaining({
        timed_out: true,
        timeoutMs: 86400000,
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
      }),
    });
  });

  it('schedules a timeout job after dispatching system scoring', async () => {
    const originalReviewTypeId = process.env.REVIEW_TYPE_ID;
    process.env.REVIEW_TYPE_ID = basePayload.reviewTypeId;
    const systemTestTimeoutSchedulerService = {
      scheduleSystemTestTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const { service, ecsService, httpService, m2mService, prisma } =
      createService(undefined, systemTestTimeoutSchedulerService);

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      active: true,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      reviewScorecardId: 'scorecard-1',
      systemTestTimeout: 3600000,
      tester: {
        id: 'tester-1',
        compilationStatus: 'SUCCESS',
      },
      phaseConfigs: [
        {
          configType: 'SYSTEM',
          startSeed: BigInt(100),
          numberOfTests: 20,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          id: basePayload.submissionId,
          virusScan: true,
        },
      }),
    );
    ecsService.launchScorerTask.mockResolvedValue({
      taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
      taskId: 'task-1',
      cluster: 'cluster',
    });

    try {
      await expect(
        service.triggerSystemScore(
          'review-1',
          basePayload.submissionId,
          basePayload.challengeId,
        ),
      ).resolves.toEqual(
        expect.objectContaining({
          taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
          taskId: 'task-1',
        }),
      );
    } finally {
      if (originalReviewTypeId === undefined) {
        delete process.env.REVIEW_TYPE_ID;
      } else {
        process.env.REVIEW_TYPE_ID = originalReviewTypeId;
      }
    }

    expect(
      systemTestTimeoutSchedulerService.scheduleSystemTestTimeout,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        challengeId: basePayload.challengeId,
        submissionId: basePayload.submissionId,
        reviewId: 'review-1',
        reviewTypeId: basePayload.reviewTypeId,
        scorecardId: 'scorecard-1',
        taskArn: 'arn:aws:ecs:us-east-1:123456789012:task/cluster/task-1',
        cluster: 'cluster',
        testPhase: 'system',
        timeoutMs: 3600000,
      }),
      3600000,
    );
  });

  it('marks system scoring failed without launching when submission has not passed virus scan', async () => {
    const systemTestTimeoutSchedulerService = {
      scheduleSystemTestTimeout: jest.fn().mockResolvedValue(undefined),
    };
    const { service, ecsService, httpService, m2mService, prisma } =
      createService(undefined, systemTestTimeoutSchedulerService);
    const skipSpy = jest
      .spyOn(service, 'markSubmissionScoringSkipped')
      .mockResolvedValue(undefined);

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      active: true,
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      taskDefinitionName: 'mm-runner',
      taskDefinitionVersion: '7',
      reviewScorecardId: 'scorecard-1',
      systemTestTimeout: 3600000,
      tester: {
        id: 'tester-1',
        compilationStatus: 'SUCCESS',
      },
      phaseConfigs: [
        {
          configType: 'SYSTEM',
          startSeed: BigInt(100),
          numberOfTests: 20,
        },
      ],
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          id: basePayload.submissionId,
          virusScan: false,
        },
      }),
    );

    await expect(
      service.triggerSystemScore(
        'review-1',
        basePayload.submissionId,
        basePayload.challengeId,
      ),
    ).resolves.toEqual({
      skipped: true,
      reason:
        'Marathon Match SYSTEM scoring skipped because the submission has not passed virus scanning.',
      reviewId: 'review-1',
      submissionId: basePayload.submissionId,
    });

    expect(ecsService.launchScorerTask).not.toHaveBeenCalled();
    expect(
      systemTestTimeoutSchedulerService.scheduleSystemTestTimeout,
    ).not.toHaveBeenCalled();
    expect(skipSpy).toHaveBeenCalledWith({
      challengeId: basePayload.challengeId,
      details: {
        virusScan: false,
      },
      reason:
        'Marathon Match SYSTEM scoring skipped because the submission has not passed virus scanning.',
      reviewId: 'review-1',
      scorecardId: 'scorecard-1',
      submissionId: basePayload.submissionId,
      testPhase: 'system',
    });
  });

  it('writes terminal failed summations for skipped submission scoring', async () => {
    const { service, httpService, m2mService, prisma } = createService();

    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      challengeId: basePayload.challengeId,
      name: 'Bridge Runners',
      submissionApiUrl: 'https://api.topcoder-dev.com/v6',
      relativeScoringEnabled: false,
      scoreDirection: ScoreDirection.MAXIMIZE,
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

    await service.markSubmissionScoringSkipped({
      challengeId: basePayload.challengeId,
      details: {
        virusScan: false,
      },
      reason:
        'Marathon Match EXAMPLE scoring skipped because the submission has not passed virus scanning.',
      submissionId: basePayload.submissionId,
      testPhase: 'example',
    });

    expect(httpService.post).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/reviewSummations',
      expect.objectContaining({
        aggregateScore: -1,
        isExample: true,
        isPassing: false,
        submissionId: basePayload.submissionId,
        metadata: expect.objectContaining({
          challengeId: basePayload.challengeId,
          marathonMatchScoringSkipped: true,
          testProgress: 1,
          testStatus: ScoringTestStatus.Failed,
          testType: 'example',
        }),
      }),
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      }),
    );
  });

  it('normalizes zero-best relative scores without NaN or Infinity', () => {
    const { service } = createService();
    const calculateRelativeScore = (service as any).calculateRelativeScore.bind(
      service,
    ) as (
      rawScore: number,
      bestScore: number | undefined,
      scoreDirection: ScoreDirection,
    ) => number;

    expect(calculateRelativeScore(0, 0, ScoreDirection.MAXIMIZE)).toBe(0);
    expect(calculateRelativeScore(50, 0, ScoreDirection.MAXIMIZE)).toBe(0);
    expect(calculateRelativeScore(0, 0, ScoreDirection.MINIMIZE)).toBe(100);
    expect(calculateRelativeScore(0, 50, ScoreDirection.MINIMIZE)).toBe(0);
    expect(calculateRelativeScore(50, 50, ScoreDirection.MAXIMIZE)).toBe(100);
  });

  it('writes recomputed relative review summations in leaderboard order', async () => {
    const { service } = createService();
    const processRelativeScoring = (service as any).processRelativeScoring.bind(
      service,
    ) as (
      token: string,
      payload: ScoringResultCallbackPayload,
      testPhase: string,
      fallbackMetadata: Record<string, unknown>,
      fallbackScorecardId: string | undefined,
      settings: {
        challengeId?: string;
        submissionApiUrl?: string;
        enabled: boolean;
        scoreDirection: ScoreDirection;
      },
    ) => Promise<number | undefined>;

    const reviewFor = (submissionId: string, rawScore: number) => ({
      id: `summation-${submissionId}`,
      aggregateScore: rawScore,
      isProvisional: true,
      metadata: {
        testType: 'provisional',
        testScores: [{ testcase: '753388858', score: rawScore }],
      },
    });

    jest.spyOn(service as any, 'fetchChallengeSubmissions').mockResolvedValue([
      {
        id: 'submission-ghost',
        memberId: 'member-ghost',
        reviewSummation: [reviewFor('submission-ghost', 100)],
      },
      {
        id: 'submission-vdave',
        memberId: 'member-vdave',
        reviewSummation: [reviewFor('submission-vdave', 88.33507138754184)],
      },
      {
        id: 'submission-bitrelica',
        memberId: 'member-bitrelica',
        reviewSummation: [reviewFor('submission-bitrelica', 79.5106923255694)],
      },
      {
        id: 'submission-kazaward',
        memberId: 'member-kazaward',
        reviewSummation: [
          reviewFor('submission-kazaward', 0.004946668727778636),
        ],
      },
      {
        id: 'submission-eulerschez',
        memberId: 'member-eulerschez',
        reviewSummation: [
          reviewFor('submission-eulerschez', 0.004946668727778636),
        ],
      },
      {
        id: 'submission-shxzhaosr',
        memberId: 'member-shxzhaosr',
        reviewSummation: [reviewFor('submission-shxzhaosr', 0)],
      },
      {
        id: 'submission-failed',
        memberId: 'member-failed',
        reviewSummation: [reviewFor('submission-failed', -1)],
      },
      {
        id: 'submission-tsegaye',
        memberId: 'member-tsegaye',
      },
    ]);
    const upsertReviewSummationSpy = jest
      .spyOn(service as any, 'upsertReviewSummation')
      .mockResolvedValue(undefined);

    const currentScore = await processRelativeScoring(
      'm2m-token',
      {
        ...basePayload,
        score: 85.82148326711835,
        submissionId: 'submission-tsegaye',
      },
      'provisional',
      {
        reviewTypeId: basePayload.reviewTypeId,
        testType: 'provisional',
        testScores: [{ testcase: '753388858', score: 85.82148326711835 }],
      },
      undefined,
      {
        challengeId: basePayload.challengeId,
        submissionApiUrl: 'https://api.topcoder-dev.com/v6',
        enabled: true,
        scoreDirection: ScoreDirection.MAXIMIZE,
      },
    );

    expect(currentScore).toBeCloseTo(85.82148326711835);
    const persistedSubmissionIds = upsertReviewSummationSpy.mock.calls.map(
      ([, , reviewPayload]) =>
        (reviewPayload as { submissionId: string }).submissionId,
    );

    expect(persistedSubmissionIds).toEqual([
      'submission-ghost',
      'submission-vdave',
      'submission-tsegaye',
      'submission-bitrelica',
      'submission-kazaward',
      'submission-eulerschez',
      'submission-shxzhaosr',
      'submission-failed',
    ]);
  });

  it('fetches all challenge submission pages using total headers when totalPages is absent', async () => {
    const { service, httpService } = createService();
    const fetchChallengeSubmissions = (
      service as any
    ).fetchChallengeSubmissions.bind(service) as (
      token: string,
      submissionApiUrl: string,
      challengeId: string,
    ) => Promise<Record<string, unknown>[]>;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `submission-${index + 1}`,
    }));
    const secondPage = [{ id: 'submission-101' }];
    const pages: Record<number, Array<{ id: string }>> = {
      1: firstPage,
      2: secondPage,
    };

    httpService.get.mockImplementation(
      (_url: string, options: { params: { page: number } }) =>
        of({
          data: {
            data: pages[options.params.page] ?? [],
          },
          headers: {
            'X-Per-Page': '100',
            'X-Total': '101',
          },
        }),
    );

    const submissions = await fetchChallengeSubmissions(
      'm2m-token',
      'https://api.topcoder-dev.com/v6',
      basePayload.challengeId,
    );

    expect(submissions).toHaveLength(101);
    expect(submissions[submissions.length - 1]).toEqual({
      id: 'submission-101',
    });
    expect(httpService.get).toHaveBeenCalledTimes(2);
    expect(httpService.get).toHaveBeenNthCalledWith(
      1,
      'https://api.topcoder-dev.com/v6/submissions',
      expect.objectContaining({
        params: expect.objectContaining({
          page: 1,
          perPage: 100,
        }),
      }),
    );
    expect(httpService.get).toHaveBeenNthCalledWith(
      2,
      'https://api.topcoder-dev.com/v6/submissions',
      expect.objectContaining({
        params: expect.objectContaining({
          page: 2,
          perPage: 100,
        }),
      }),
    );
  });

  it('fetches another submission page when pagination metadata is missing and the page is full', async () => {
    const { service, httpService } = createService();
    const fetchChallengeSubmissions = (
      service as any
    ).fetchChallengeSubmissions.bind(service) as (
      token: string,
      submissionApiUrl: string,
      challengeId: string,
    ) => Promise<Record<string, unknown>[]>;
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: `submission-${index + 1}`,
    }));
    const secondPage = [{ id: 'submission-101' }];
    const pages: Record<number, Array<{ id: string }>> = {
      1: firstPage,
      2: secondPage,
    };

    httpService.get.mockImplementation(
      (_url: string, options: { params: { page: number } }) =>
        of({
          data: pages[options.params.page] ?? [],
          headers: {},
        }),
    );

    const submissions = await fetchChallengeSubmissions(
      'm2m-token',
      'https://api.topcoder-dev.com/v6',
      basePayload.challengeId,
    );

    expect(submissions).toHaveLength(101);
    expect(submissions[submissions.length - 1]).toEqual({
      id: 'submission-101',
    });
    expect(httpService.get).toHaveBeenCalledTimes(2);
  });

  it('excludes no-credit and errored scores from MINIMIZE best-score baselines', () => {
    const { service } = createService();
    const computeBestScores = (service as any).computeBestScores.bind(
      service,
    ) as (
      reviewRecords: Array<{
        rawTestScores: Array<{
          testcase: string;
          score: number;
          error?: string;
        }>;
      }>,
      scoreDirection: ScoreDirection,
    ) => Map<string, number>;

    const bestScores = computeBestScores(
      [
        {
          rawTestScores: [
            { testcase: 'seed-1', score: 0 },
            { testcase: 'seed-2', score: 5, error: 'runtime error' },
            { testcase: 'seed-3', score: -1 },
          ],
        },
        {
          rawTestScores: [
            { testcase: 'seed-1', score: 40 },
            { testcase: 'seed-2', score: 30 },
            { testcase: 'seed-3', score: 60 },
          ],
        },
        {
          rawTestScores: [
            { testcase: 'seed-1', score: 10 },
            { testcase: 'seed-2', score: 20 },
            { testcase: 'seed-3', score: 50 },
          ],
        },
      ],
      ScoreDirection.MINIMIZE,
    );

    expect(bestScores.get('seed-1')).toBe(10);
    expect(bestScores.get('seed-2')).toBe(20);
    expect(bestScores.get('seed-3')).toBe(50);
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

  it('groups relative reviews by extracted submission ID and member identity', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberKey?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          submissionId: 'member-latest',
          member: {
            id: 'member-1',
            handle: 'competitor',
          },
          submittedDate: '2026-05-28T15:23:32.877Z',
          reviewSummations: [
            {
              id: 'member-latest-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
              },
            },
          ],
        },
        {
          submissionId: 'member-older',
          member: {
            id: 'member-1',
            handle: 'competitor',
          },
          submittedDate: '2026-05-28T15:21:12.605Z',
          reviewSummations: [
            {
              id: 'member-older-review',
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
        submissionId: 'member-latest',
        rawTestScores: [expect.objectContaining({ score: 100 })],
      }),
    );
  });

  it('excludes the current member from relative scoring by handle when memberId is missing', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberKey?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          id: 'older-current-member-submission',
          memberHandle: 'eulerscheZahl',
          submittedDate: '2026-05-28T15:21:12.605Z',
          reviewSummation: [
            {
              id: 'older-current-member-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
              },
            },
          ],
        },
        {
          id: 'other-member-submission',
          memberHandle: 'other',
          submittedDate: '2026-05-28T15:22:12.605Z',
          reviewSummation: [
            {
              id: 'other-member-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 50 }],
              },
            },
          ],
        },
      ],
      'provisional',
      basePayload.reviewTypeId,
      'current-submission',
      'eulerscheZahl',
    );

    expect(records).toHaveLength(1);
    expect(records[0]).toEqual(
      expect.objectContaining({
        submissionId: 'other-member-submission',
        rawTestScores: [expect.objectContaining({ score: 50 })],
      }),
    );
  });

  it('prefers explicitly latest relative reviews before timestamp fallback', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberKey?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          id: 'newer-by-date',
          memberId: 'member-1',
          isLatest: false,
          submittedDate: '2026-05-28T15:23:32.877Z',
          reviewSummation: [
            {
              id: 'newer-by-date-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 10 }],
              },
            },
          ],
        },
        {
          id: 'marked-latest',
          memberId: 'member-1',
          isLatest: true,
          submittedDate: '2026-05-28T15:21:12.605Z',
          reviewSummation: [
            {
              id: 'marked-latest-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
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
        submissionId: 'marked-latest',
        rawTestScores: [expect.objectContaining({ score: 100 })],
      }),
    );
  });

  it('collapses relative scoring candidates by nested submitter identity', () => {
    const { service } = createService();
    const selectLatestRelativeReviewRecords = (
      service as any
    ).selectLatestRelativeReviewRecords.bind(service) as (
      submissions: Record<string, unknown>[],
      testPhase: string,
      reviewTypeId: string,
      excludedSubmissionId: string,
      excludedMemberKey?: string,
    ) => Array<{
      submissionId: string;
      rawTestScores: Array<{ score: number }>;
    }>;

    const records = selectLatestRelativeReviewRecords(
      [
        {
          id: 'older-gaha-submission',
          submitter: {
            id: 'gaha-member-id',
            handle: 'gaha',
          },
          submittedDate: '2026-05-28T15:21:12.605Z',
          reviewSummation: [
            {
              id: 'older-gaha-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 10 }],
              },
            },
          ],
        },
        {
          submissionId: 'latest-gaha-submission',
          submitter: {
            id: 'gaha-member-id',
            handle: 'gaha',
          },
          createdAt: '2026-05-28T15:23:32.878Z',
          isLatest: true,
          reviewSummations: [
            {
              id: 'latest-gaha-review',
              isProvisional: true,
              metadata: {
                testType: 'provisional',
                testScores: [{ testcase: '753388858', score: 100 }],
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
        submissionId: 'latest-gaha-submission',
        rawTestScores: [expect.objectContaining({ score: 100 })],
      }),
    );
  });
});
