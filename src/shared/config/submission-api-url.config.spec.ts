import {
  resolvePersistedSubmissionApiBaseUrl,
  resolveSubmissionApiBaseUrl,
} from './submission-api-url.config';

describe('submission API URL configuration', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.SUBMISSION_API_URL;
    delete process.env.CHALLENGE_API_URL;
    delete process.env.MARATHON_MATCH_API_URL;
    delete process.env.REVIEW_API_URL;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('derives the default submission API URL from the prod challenge API base', () => {
    process.env.CHALLENGE_API_URL = 'https://api.topcoder.com';

    expect(resolvePersistedSubmissionApiBaseUrl()).toBe(
      'https://api.topcoder.com/v6',
    );
  });

  it('prefers the runtime SUBMISSION_API_URL override over persisted config', () => {
    process.env.SUBMISSION_API_URL = 'https://api.topcoder.com/v6';

    expect(
      resolveSubmissionApiBaseUrl({
        configuredUrl: 'https://api.topcoder-dev.com/v6',
        environmentUrls: ['https://api.topcoder.com'],
      }),
    ).toBe('https://api.topcoder.com/v6');
  });

  it('rejects topcoder-dev submission API URLs in prod Topcoder deployments', () => {
    process.env.CHALLENGE_API_URL = 'https://api.topcoder.com';

    expect(() =>
      resolvePersistedSubmissionApiBaseUrl('https://api.topcoder-dev.com/v6'),
    ).toThrow(
      'Production Topcoder Marathon Match must not use topcoder-dev Submission API URLs.',
    );
  });

  it('rejects submission collection URLs', () => {
    expect(() =>
      resolvePersistedSubmissionApiBaseUrl(
        'https://api.topcoder.com/v6/submissions',
        'https://api.topcoder.com',
      ),
    ).toThrow('must be the API base URL');
  });
});
