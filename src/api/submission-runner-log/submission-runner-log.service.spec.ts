import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { of } from 'rxjs';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { LoggerService } from 'src/shared/modules/global/logger.service';

jest.mock('src/shared/modules/global/m2m.service', () => ({
  M2MService: class M2MService {},
}));

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { SubmissionRunnerLogService } from './submission-runner-log.service';

describe('SubmissionRunnerLogService', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };
  const baseDate = new Date('2026-06-01T00:00:00.000Z');

  const buildMappingRecord = (overrides: Record<string, unknown> = {}) => ({
    id: 'mapping-1',
    submissionId: 'submission-1',
    challengeId: 'challenge-1',
    taskArn: 'arn:aws:ecs:task/runner',
    taskId: 'runner-task',
    cluster: 'cluster-1',
    containerName: 'tc-mm-runner',
    taskDefinition: 'mm-ecs-runner:1',
    phaseConfigType: null,
    logGroup: null,
    logStreamPrefix: null,
    logStreamName: null,
    cloudWatchLogsConsoleUrl: null,
    createdAt: baseDate,
    updatedAt: baseDate,
    ...overrides,
  });

  const createService = () => {
    const httpService = {
      get: jest.fn(),
    };
    const m2mService = {
      getM2MToken: jest.fn(),
    };
    const prisma = {
      submissionRunnerLog: {
        findMany: jest.fn(),
      },
      marathonMatchConfig: {
        findUnique: jest.fn(),
      },
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new SubmissionRunnerLogService(
      httpService as never,
      m2mService as never,
      prisma as never,
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

  it('rejects machine tokens before runner-log mapping lookup', async () => {
    const { service, prisma, m2mService, httpService } = createService();

    await expect(
      service.getLogsForSubmission(
        'submission-1',
        {},
        {
          isMachine: true,
          userId: 'svc-client',
          scopes: ['read:marathon-match'],
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(prisma.submissionRunnerLog.findMany).not.toHaveBeenCalled();
    expect(prisma.marathonMatchConfig.findUnique).not.toHaveBeenCalled();
    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('filters mappings by the authorized challenge id when provided', async () => {
    const { service, prisma } = createService();
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);

    const response = await service.getLogsForSubmission(
      ' submission-1 ',
      {
        authorizedChallengeId: ' challenge-1 ',
      },
      {
        isMachine: false,
        userId: 'copilot-1',
        roles: [UserRole.Copilot],
      },
    );

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

  it('keeps the existing submission-only lookup for administrators when no challenge scope is provided', async () => {
    const { service, prisma } = createService();
    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);

    await service.getLogsForSubmission(
      'submission-1',
      {},
      {
        isMachine: false,
        userId: 'admin-1',
        roles: [UserRole.Admin],
      },
    );

    expect(prisma.submissionRunnerLog.findMany).toHaveBeenCalledWith({
      where: {
        submissionId: 'submission-1',
      },
      orderBy: [{ createdAt: 'desc' }],
    });
  });

  it('returns not found when the authorized challenge has no mapping', async () => {
    const { service, prisma } = createService();
    prisma.submissionRunnerLog.findMany.mockResolvedValue([]);

    await expect(
      service.getLogsForSubmission(
        'submission-1',
        {
          authorizedChallengeId: 'challenge-2',
        },
        {
          isMachine: false,
          userId: 'copilot-1',
          roles: [UserRole.Copilot],
        },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects non-owner users before returning runner-log mappings', async () => {
    const { service, prisma, m2mService, httpService } = createService();

    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);
    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      submissionApiUrl: 'https://submission.example.com/v6/',
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          id: 'submission-1',
          memberId: 'owner-1',
          memberHandle: 'ownerHandle',
        },
      }),
    );

    await expect(
      service.getLogsForSubmission(
        'submission-1',
        {},
        {
          isMachine: false,
          userId: 'other-user',
          handle: 'otherHandle',
          roles: [UserRole.User],
        },
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://submission.example.com/v6/submissions/submission-1',
      {
        headers: {
          Authorization: 'Bearer m2m-token',
        },
      },
    );
  });

  it('allows the submission owner to read runner-log mappings', async () => {
    const { service, prisma, m2mService, httpService } = createService();

    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);
    prisma.marathonMatchConfig.findUnique.mockResolvedValue({
      submissionApiUrl: 'https://submission.example.com/v6',
    });
    m2mService.getM2MToken.mockResolvedValue('m2m-token');
    httpService.get.mockReturnValue(
      of({
        data: {
          result: {
            content: [
              {
                id: 'submission-1',
                memberId: 'owner-1',
              },
            ],
          },
        },
      }),
    );

    const response = await service.getLogsForSubmission(
      'submission-1',
      {},
      {
        isMachine: false,
        userId: 'owner-1',
        roles: [UserRole.User],
      },
    );

    expect(response).toEqual(
      expect.objectContaining({
        submissionId: 'submission-1',
        selectedTaskArn: 'arn:aws:ecs:task/runner',
        events: [],
        warning:
          'Selected mapping does not yet include logGroup/logStreamName values.',
      }),
    );
    expect(response.selectedMapping).toEqual(
      expect.objectContaining({
        submissionId: 'submission-1',
        challengeId: 'challenge-1',
      }),
    );
  });

  it('allows administrators without ownership lookup', async () => {
    const { service, prisma, m2mService, httpService } = createService();

    prisma.submissionRunnerLog.findMany.mockResolvedValue([
      buildMappingRecord(),
    ]);

    const response = await service.getLogsForSubmission(
      'submission-1',
      {},
      {
        isMachine: false,
        userId: 'admin-1',
        roles: [UserRole.Admin],
      },
    );

    expect(response.selectedMapping.submissionId).toBe('submission-1');
    expect(prisma.marathonMatchConfig.findUnique).not.toHaveBeenCalled();
    expect(m2mService.getM2MToken).not.toHaveBeenCalled();
    expect(httpService.get).not.toHaveBeenCalled();
  });
});
