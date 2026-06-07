import { NotFoundException } from '@nestjs/common';

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { SubmissionRunnerLogService } from './submission-runner-log.service';

const baseDate = new Date('2026-01-01T00:00:00.000Z');

/**
 * Builds a complete submissionRunnerLog record for service unit tests.
 * @param overrides Optional fields to replace on the default mapping.
 * @returns A record shape compatible with `SubmissionRunnerLogService`.
 * Used by tests that should avoid real database and CloudWatch dependencies.
 */
function buildMappingRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mapping-1',
    submissionId: 'submission-1',
    challengeId: 'challenge-1',
    taskArn: 'task-arn-1',
    taskId: 'task-1',
    cluster: 'cluster-1',
    containerName: 'runner',
    taskDefinition: 'mm-ecs-runner:1',
    phaseConfigType: null,
    logGroup: null,
    logStreamPrefix: null,
    logStreamName: null,
    cloudWatchLogsConsoleUrl: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    ...overrides,
  };
}

describe('SubmissionRunnerLogService', () => {
  let prisma: {
    submissionRunnerLog: {
      findMany: jest.Mock;
    };
  };
  let service: SubmissionRunnerLogService;

  beforeEach(() => {
    prisma = {
      submissionRunnerLog: {
        findMany: jest.fn(),
      },
    };
    service = new SubmissionRunnerLogService(prisma as any);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('filters mappings by the authorized challenge id when provided', async () => {
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);

    const response = await service.getLogsForSubmission(' submission-1 ', {
      authorizedChallengeId: ' challenge-1 ',
    });

    expect(prisma.submissionRunnerLog.findMany).toHaveBeenCalledWith({
      where: {
        submissionId: 'submission-1',
        challengeId: 'challenge-1',
      },
      orderBy: [{ createdAt: 'desc' }],
    });
    expect(response.submissionId).toBe('submission-1');
    expect(response.mappings).toHaveLength(1);
    expect(response.warning).toBe(
      'Selected mapping does not yet include logGroup/logStreamName values.',
    );
  });

  it('keeps the existing submission-only lookup when no challenge scope is provided', async () => {
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);

    await service.getLogsForSubmission('submission-1', {});

    expect(prisma.submissionRunnerLog.findMany).toHaveBeenCalledWith({
      where: {
        submissionId: 'submission-1',
      },
      orderBy: [{ createdAt: 'desc' }],
    });
  });

  it('returns not found when the authorized challenge has no mapping', async () => {
    prisma.submissionRunnerLog.findMany.mockResolvedValue([]);

    await expect(
      service.getLogsForSubmission('submission-1', {
        authorizedChallengeId: 'challenge-2',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
