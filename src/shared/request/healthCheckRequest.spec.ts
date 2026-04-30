import { isHealthCheckRequestUrl } from './healthCheckRequest';

describe('isHealthCheckRequestUrl', () => {
  it.each(['/health', '/health/', '/health?source=elb'])(
    'matches unprefixed health path %s',
    (url) => {
      expect(isHealthCheckRequestUrl(url)).toBe(true);
    },
  );

  it.each([
    '/v6/marathon-match/health',
    '/v6/marathon-match/health/',
    '/v6/marathon-match/health?source=elb',
  ])('matches prefixed health path %s', (url) => {
    expect(isHealthCheckRequestUrl(url)).toBe(true);
  });

  it.each([
    undefined,
    '',
    '/v6/marathon-match/healthz',
    '/v6/marathon-match/challenges/health',
  ])('does not match non-health path %s', (url) => {
    expect(isHealthCheckRequestUrl(url)).toBe(false);
  });
});
