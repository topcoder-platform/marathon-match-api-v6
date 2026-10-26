import { UnauthorizedException } from '@nestjs/common';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';
import { JwtService } from './jwt.service';

jest.mock('axios', () => ({
  __esModule: true,
  default: {
    get: jest.fn(),
  },
}));

jest.mock('tc-core-library-js', () => ({ createJwtVerifier: jest.fn() }));

describe('JwtService', () => {
  const originalEnv = process.env;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const mockAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
  const mockJwtVerifier = jest.requireMock('tc-core-library-js').createJwtVerifier as jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AUTHORIZATION_VALIDATION_URL;
    delete process.env.AUTHORIZATION_VALIDATION_TIMEOUT_MS;
    process.env.AUTHORIZATION_SESSION_VALIDATION_ENABLED = 'true';

    mockJwtVerifier.mockReset();
    mockJwtVerifier.mockReturnValue({ verify: async (token: string) => {
      const payload = jwt.decode(token) as jwt.JwtPayload;
      return { ...payload, roles: payload.roles ?? [], scopes: typeof payload.scope === 'string' ? payload.scope.split(' ') : [], isMachine: payload.gty === 'client-credentials' };
    } });
    mockAxiosGet.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  /**
   * Creates a service with mocked tc-core validation.
   * @returns Initialized JWT service.
   * Used by tests to exercise this service's post-JWT session validation logic.
   */
  function createService(): JwtService {
    const service = new JwtService();
    service.onModuleInit();
    return service;
  }

  /**
   * Creates a signed JWT with an issuer that maps to the Identity API.
   * @param payload Additional JWT payload fields.
   * @returns JWT string.
   * Used by tests to drive validation without relying on real Topcoder secrets.
   */
  function createToken(payload: Record<string, unknown>): string {
    return jwt.sign(
      {
        iss: 'https://api.topcoder-dev.com',
        userId: '123',
        handle: 'tester',
        roles: ['Topcoder User'],
        ...payload,
      },
      'test-secret',
    );
  }

  it('validates active Identity API authorization for Topcoder user tokens', async () => {
    mockAxiosGet.mockResolvedValue({ status: 200 });
    const token = createToken({});

    await expect(createService().validateToken(token)).resolves.toMatchObject({
      userId: '123',
      handle: 'tester',
      isMachine: false,
    });

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://api.topcoder-dev.com/v6/authorizations/1',
      expect.objectContaining({
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          fields: 'token',
        },
        timeout: 3000,
      }),
    );
  });

  it('rejects user tokens when Identity API reports the authorization is inactive', async () => {
    mockAxiosGet.mockResolvedValue({ status: 401 });

    await expect(
      createService().validateToken(createToken({})),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('uses configured Identity API validation URL and timeout', async () => {
    process.env.AUTHORIZATION_VALIDATION_URL =
      'https://identity.example.com/v6/authorizations/1';
    process.env.AUTHORIZATION_VALIDATION_TIMEOUT_MS = '1500';
    mockAxiosGet.mockResolvedValue({ status: 200 });
    const token = createToken({});

    await createService().validateToken(token);

    expect(mockAxiosGet).toHaveBeenCalledWith(
      'https://identity.example.com/v6/authorizations/1',
      expect.objectContaining({
        timeout: 1500,
      }),
    );
  });

  it('does not call Identity API for scoped M2M tokens', async () => {
    const token = createToken({
      scope: 'read:marathon-match',
      gty: 'client-credentials',
      userId: undefined, roles: undefined,
    });

    await expect(createService().validateToken(token)).resolves.toMatchObject({
      isMachine: true,
      scopes: expect.arrayContaining(['read:marathon-match']),
    });

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
