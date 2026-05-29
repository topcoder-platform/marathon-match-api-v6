import { of } from 'rxjs';
import { LoggerService } from 'src/shared/modules/global/logger.service';

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { ScoringCompletionEmailService } from './scoring-completion-email.service';

describe('ScoringCompletionEmailService', () => {
  const originalEnv = process.env;
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const details = {
    aggregateExampleScore: 95.25,
    aggregateProvisionalScore: 87.5,
    challengeId: '30000123',
    challengeName: 'Blocks',
    memberHandle: 'competitor',
    scoringStatus: 'pass',
    submissionId: 'submission-1',
  };
  const systemDetails = {
    challengeId: '30000123',
    challengeName: 'Blocks',
    finalSystemScore: 91.5,
    memberHandle: 'competitor',
    placement: '1st',
    scoringStatus: 'pass',
    submissionId: 'submission-1',
  };

  const createService = () => {
    const httpService = {
      get: jest.fn(),
      post: jest.fn(),
    };
    const prisma = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      $queryRaw: jest.fn(),
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new ScoringCompletionEmailService(
      httpService as never,
      prisma as never,
    );

    return {
      httpService,
      prisma,
      service,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = {
      ...originalEnv,
      BUS_API_URL: 'https://api.topcoder-dev.com/v5',
      MEMBER_API_URL: 'https://api.topcoder-dev.com/v6',
      SENDGRID_TEMPLATE_ID_SCORING_COMPLETE: 'sendgrid-template-id',
      SENDGRID_TEMPLATE_ID_SYSTEM_TEST_RESULTS: 'system-template-id',
      TC_EMAIL_FROM_EMAIL: 'no-reply@topcoder.com',
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.restoreAllMocks();
  });

  it('sends one completion email through Bus API and marks the notification sent', async () => {
    const { httpService, prisma, service } = createService();

    prisma.$queryRaw.mockResolvedValue([{ id: 'notification-1' }]);
    httpService.get.mockReturnValue(
      of({
        data: {
          email: 'competitor@example.com',
          handle: 'competitor',
        },
      }),
    );
    httpService.post.mockReturnValue(of({ status: 202 }));

    await expect(
      service.sendSubmissionScoringCompleteEmail('m2m-token', details),
    ).resolves.toBe(undefined);

    expect(httpService.get).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/members/competitor',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer m2m-token',
        },
        params: {
          fields: 'handle,email',
        },
      }),
    );

    expect(httpService.post).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v5/bus/events',
      expect.objectContaining({
        payload: expect.objectContaining({
          recipients: ['competitor@example.com'],
          sendgrid_template_id: 'sendgrid-template-id',
          data: expect.objectContaining({
            aggregateExampleScore: details.aggregateExampleScore,
            aggregateProvisionalScore: details.aggregateProvisionalScore,
            challengeId: details.challengeId,
            challengeName: details.challengeName,
            challengeUrl: 'https://topcoder.com/challenges/30000123',
            memberHandle: details.memberHandle,
            scoringStatus: 'pass',
            submissionId: details.submissionId,
          }),
        }),
        topic: 'external.action.email',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer m2m-token',
        }),
      }),
    );
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('sends one system results email through Bus API and marks the notification sent', async () => {
    const { httpService, prisma, service } = createService();

    prisma.$queryRaw.mockResolvedValue([{ id: 'notification-1' }]);
    httpService.get.mockReturnValue(
      of({
        data: {
          email: 'competitor@example.com',
          handle: 'competitor',
        },
      }),
    );
    httpService.post.mockReturnValue(of({ status: 202 }));

    await expect(
      service.sendSystemScoringCompleteEmail('m2m-token', systemDetails),
    ).resolves.toBe(undefined);

    expect(httpService.post).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v5/bus/events',
      expect.objectContaining({
        payload: expect.objectContaining({
          recipients: ['competitor@example.com'],
          sendgrid_template_id: 'system-template-id',
          data: expect.objectContaining({
            challengeId: systemDetails.challengeId,
            challengeName: systemDetails.challengeName,
            challengeUrl: 'https://topcoder.com/challenges/30000123',
            finalSystemScore: systemDetails.finalSystemScore,
            memberHandle: systemDetails.memberHandle,
            placement: '1st',
            scoringStatus: 'pass',
            submissionId: systemDetails.submissionId,
          }),
        }),
        topic: 'external.action.email',
      }),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer m2m-token',
        }),
      }),
    );
    const sentPayload = httpService.post.mock.calls[0][1].payload.data;
    expect(sentPayload.aggregateExampleScore).toBeUndefined();
    expect(sentPayload.aggregateProvisionalScore).toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('skips sending when a sent or active notification marker already exists', async () => {
    const { httpService, prisma, service } = createService();

    prisma.$queryRaw.mockResolvedValue([]);

    await expect(
      service.sendSubmissionScoringCompleteEmail('m2m-token', details),
    ).resolves.toBe(undefined);

    expect(httpService.get).not.toHaveBeenCalled();
    expect(httpService.post).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });
});
