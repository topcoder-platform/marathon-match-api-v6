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

jest.mock('tc-core-library-js', () => ({
  auth: { createValidator: jest.fn() },
}));

describe('JwtService', () => {
  const originalEnv = process.env;
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const mockAxiosGet = axios.get as jest.MockedFunction<typeof axios.get>;
  const mockCreateValidator = jest.requireMock('tc-core-library-js').auth.createValidator as jest.Mock;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AUTHORIZATION_VALIDATION_URL;
    delete process.env.AUTHORIZATION_VALIDATION_TIMEOUT_MS;
    process.env.AUTHORIZATION_SESSION_VALIDATION_ENABLED = 'true';

    mockCreateValidator.mockReset();
    mockCreateValidator.mockReturnValue({ verify: jest.fn(async (token: string) => {
      const payload = jwt.decode(token) as Record<string, unknown>;
      return { ...payload, kind: payload.kind || 'user', isMachine: payload.kind === 'service',
        roles: payload.kind === 'service' ? [] : payload.roles,
        scopes: payload.kind === 'service' ? ['read:marathon-match'] : [],
      };
    }) });
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
    const token = createToken({ scope: 'openid read:marathon-match' });

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

  it('does not call Identity API for verified service principals', async () => {
    const token = createToken({
      kind: 'service',
      userId: undefined,
      scope: 'read:marathon-match',
    });

    await expect(createService().validateToken(token)).resolves.toMatchObject({
      isMachine: true,
      scopes: expect.arrayContaining(['read:marathon-match']),
    });

    expect(mockAxiosGet).not.toHaveBeenCalled();
  });
});
