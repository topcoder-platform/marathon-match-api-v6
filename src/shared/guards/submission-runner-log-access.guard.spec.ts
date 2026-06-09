import { HttpService } from '@nestjs/axios';
import {
  ExecutionContext,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { of } from 'rxjs';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { JwtUser } from 'src/shared/modules/global/jwt.service';

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import {
  RunnerLogAccessRequest,
  SubmissionRunnerLogAccessGuard,
} from './submission-runner-log-access.guard';

type TestRequest = RunnerLogAccessRequest & {
  headers: Record<string, string | undefined>;
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
  user?: JwtUser;
};

/**
 * Builds a minimal Nest execution context with an HTTP request.
 * @param request Request fragment consumed by `SubmissionRunnerLogAccessGuard`.
 * @returns Execution context suitable for guard unit tests.
 * Used by guard tests to avoid creating a full Nest application.
 */
function buildContext(request: TestRequest): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as ExecutionContext;
}

describe('SubmissionRunnerLogAccessGuard', () => {
  const originalResourcesApiUrl = process.env.RESOURCES_API_URL;
  let consoleWarnSpy: jest.SpyInstance;
  let httpService: Pick<HttpService, 'get'>;
  let prisma: {
    submissionRunnerLog: {
      findFirst: jest.Mock;
    };
  };
  let guard: SubmissionRunnerLogAccessGuard;

  /**
   * Creates a guard with mocked persistence and resource-api clients.
   * @returns A fresh guard instance for each authorization test.
   * Used by `beforeEach` so tests do not share mock state.
   */
  function createGuard(): SubmissionRunnerLogAccessGuard {
    process.env.RESOURCES_API_URL =
      'https://resources.example.com/v6/resources';
    httpService = {
      get: jest.fn(),
    };
    prisma = {
      submissionRunnerLog: {
        findFirst: jest.fn(),
      },
    };

    return new SubmissionRunnerLogAccessGuard(
      httpService as HttpService,
      prisma as any,
    );
  }

  beforeEach(() => {
    consoleWarnSpy = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    guard = createGuard();
  });

  afterEach(() => {
    consoleWarnSpy.mockRestore();
    process.env.RESOURCES_API_URL = originalResourcesApiUrl;
    jest.clearAllMocks();
  });

  it('allows administrator users without looking up submission mappings', async () => {
    const request: TestRequest = {
      headers: {},
      params: {
        submissionId: 'submission-1',
      },
      query: {},
      user: {
        isMachine: false,
        roles: [UserRole.Admin],
        userId: '123',
      },
    };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(prisma.submissionRunnerLog.findFirst).not.toHaveBeenCalled();
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('allows ordinary users to continue to submission ownership checks', async () => {
    const request: TestRequest = {
      headers: {},
      params: {
        submissionId: 'submission-1',
      },
      query: {},
      user: {
        isMachine: false,
        roles: [UserRole.User],
        userId: '123',
      },
    };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(prisma.submissionRunnerLog.findFirst).not.toHaveBeenCalled();
    expect(httpService.get).not.toHaveBeenCalled();
    expect(request.runnerLogAccess).toBeUndefined();
  });

  it('allows a manager resource assigned to the mapped challenge', async () => {
    prisma.submissionRunnerLog.findFirst.mockResolvedValue({
      challengeId: 'challenge-1',
    });
    (httpService.get as jest.Mock).mockReturnValue(
      of({
        data: [
          {
            memberId: '123',
            roleName: 'Manager',
          },
        ],
      }),
    );
    const request: TestRequest = {
      headers: {
        authorization: 'Bearer user-token',
      },
      params: {
        submissionId: 'submission-1',
      },
      query: {},
      user: {
        isMachine: false,
        roles: [UserRole.ProjectManager],
        userId: '123',
      },
    };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(prisma.submissionRunnerLog.findFirst).toHaveBeenCalledWith({
      where: {
        submissionId: 'submission-1',
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        challengeId: true,
      },
    });
    expect(httpService.get).toHaveBeenCalledWith(
      'https://resources.example.com/v6/resources?challengeId=challenge-1&page=1&perPage=100&memberId=123',
      {
        headers: {
          Authorization: 'Bearer user-token',
        },
      },
    );
    expect(request.runnerLogAccess).toEqual({
      submissionId: 'submission-1',
      challengeId: 'challenge-1',
    });
  });

  it('scopes authorization to the requested task ARN when provided', async () => {
    prisma.submissionRunnerLog.findFirst.mockResolvedValue({
      challengeId: 'challenge-2',
    });
    (httpService.get as jest.Mock).mockReturnValue(
      of({
        data: [
          {
            memberHandle: 'copilotHandle',
            resourceRole: {
              name: 'Copilot',
            },
          },
        ],
      }),
    );
    const request: TestRequest = {
      headers: {
        authorization: 'Bearer user-token',
      },
      params: {
        submissionId: 'submission-2',
      },
      query: {
        taskArn: 'task-arn-2',
      },
      user: {
        handle: 'copilotHandle',
        isMachine: false,
        roles: [UserRole.Copilot],
      },
    };

    await expect(guard.canActivate(buildContext(request))).resolves.toBe(true);
    expect(prisma.submissionRunnerLog.findFirst).toHaveBeenCalledWith({
      where: {
        submissionId: 'submission-2',
        taskArn: 'task-arn-2',
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        challengeId: true,
      },
    });
    expect(request.runnerLogAccess).toEqual({
      submissionId: 'submission-2',
      challengeId: 'challenge-2',
    });
  });

  it('rejects a global copilot who is not assigned to the mapped challenge', async () => {
    prisma.submissionRunnerLog.findFirst.mockResolvedValue({
      challengeId: 'challenge-1',
    });
    (httpService.get as jest.Mock).mockReturnValue(
      of({
        data: [
          {
            memberId: '123',
            roleName: 'Submitter',
          },
        ],
      }),
    );

    await expect(
      guard.canActivate(
        buildContext({
          headers: {
            authorization: 'Bearer user-token',
          },
          params: {
            submissionId: 'submission-1',
          },
          query: {},
          user: {
            isMachine: false,
            roles: [UserRole.Copilot],
            userId: '123',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('returns not found when no submission runner log mapping exists', async () => {
    prisma.submissionRunnerLog.findFirst.mockResolvedValue(null);

    await expect(
      guard.canActivate(
        buildContext({
          headers: {
            authorization: 'Bearer user-token',
          },
          params: {
            submissionId: 'missing-submission',
          },
          query: {},
          user: {
            isMachine: false,
            roles: [UserRole.ProjectManager],
            userId: '123',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
