import { HttpService } from '@nestjs/axios';
import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { ChallengeCopilotResourceGuard } from './challenge-copilot-resource.guard';

type TestRequest = {
  headers: Record<string, string | undefined>;
  params: Record<string, string | undefined>;
  user?: JwtUser;
};

/**
 * Builds a minimal Nest execution context with an HTTP request.
 * @param request Request fragment consumed by `ChallengeCopilotResourceGuard`.
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

describe('ChallengeCopilotResourceGuard', () => {
  const originalResourcesApiUrl = process.env.RESOURCES_API_URL;
  let consoleWarnSpy: jest.SpyInstance;
  let httpService: Pick<HttpService, 'get'>;
  let guard: ChallengeCopilotResourceGuard;

  /**
   * Creates a guard with a mocked HTTP service and deterministic resource-api URL.
   * @returns A fresh guard instance for each authorization test.
   * Used by `beforeEach` so tests do not share HTTP mock state.
   */
  function createGuard(): ChallengeCopilotResourceGuard {
    process.env.RESOURCES_API_URL =
      'https://resources.example.com/v6/resources';
    httpService = {
      get: jest.fn(),
    };

    return new ChallengeCopilotResourceGuard(httpService as HttpService);
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

  it('allows administrator users without a resource lookup', async () => {
    const canActivate = await guard.canActivate(
      buildContext({
        headers: {},
        params: {
          challengeId: 'challenge-1',
        },
        user: {
          isMachine: false,
          roles: [UserRole.Admin],
          userId: '123',
        },
      }),
    );

    expect(canActivate).toBe(true);
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('allows scoped machine tokens without a resource lookup', async () => {
    const canActivate = await guard.canActivate(
      buildContext({
        headers: {},
        params: {
          challengeId: 'challenge-1',
        },
        user: {
          isMachine: true,
          scopes: [Scope.UpdateMarathonMatch],
          userId: 'machine-client',
        },
      }),
    );

    expect(canActivate).toBe(true);
    expect(httpService.get).not.toHaveBeenCalled();
  });

  it('allows a member assigned as the challenge copilot resource', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      of({
        data: [
          {
            memberId: '123',
            roleName: 'Copilot',
          },
        ],
      }),
    );

    const canActivate = await guard.canActivate(
      buildContext({
        headers: {
          authorization: 'Bearer user-token',
        },
        params: {
          challengeId: 'challenge-1',
        },
        user: {
          isMachine: false,
          roles: [UserRole.User],
          userId: '123',
        },
      }),
    );

    expect(canActivate).toBe(true);
    expect(httpService.get).toHaveBeenCalledWith(
      'https://resources.example.com/v6/resources?challengeId=challenge-1&page=1&perPage=100&memberId=123',
      {
        headers: {
          Authorization: 'Bearer user-token',
        },
      },
    );
  });

  it('rejects a global copilot who is not the challenge copilot resource', async () => {
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
            challengeId: 'challenge-1',
          },
          user: {
            isMachine: false,
            roles: [UserRole.Copilot],
            userId: '123',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a copilot when resource-api access cannot be verified', async () => {
    (httpService.get as jest.Mock).mockReturnValue(
      throwError(() => new Error('resource-api unavailable')),
    );

    await expect(
      guard.canActivate(
        buildContext({
          headers: {
            authorization: 'Bearer user-token',
          },
          params: {
            challengeId: 'challenge-1',
          },
          user: {
            isMachine: false,
            roles: [UserRole.Copilot],
            userId: '123',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
