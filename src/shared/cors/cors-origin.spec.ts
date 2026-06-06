import {
  buildConfiguredCorsOrigin,
  buildCorsOrigin,
  DEFAULT_CORS_ALLOWED_ORIGINS,
  type CorsOriginDelegate,
} from './cors-origin';

function checkOrigin(originDelegate: CorsOriginDelegate, origin: string) {
  let result: boolean | undefined;

  originDelegate(origin, (error, allow) => {
    expect(error).toBeNull();
    result = allow;
  });

  return result;
}

describe('CORS origin configuration', () => {
  it('allows only the exact configured origin', () => {
    const originDelegate = buildConfiguredCorsOrigin('https://topcoder.com');

    expect(checkOrigin(originDelegate, 'https://topcoder.com')).toBe(true);
    expect(
      checkOrigin(originDelegate, 'https://evil-topcoder.com.attacker.com'),
    ).toBe(false);
    expect(checkOrigin(originDelegate, 'https://nottopcoder.com')).toBe(false);
  });

  it('trims the configured origin before matching', () => {
    const originDelegate = buildConfiguredCorsOrigin('  https://topcoder.com ');

    expect(checkOrigin(originDelegate, 'https://topcoder.com')).toBe(true);
  });

  it('uses the built-in allowlist when CORS_ALLOWED_ORIGIN is not set', () => {
    expect(buildCorsOrigin()).toBe(DEFAULT_CORS_ALLOWED_ORIGINS);
    expect(buildCorsOrigin('   ')).toBe(DEFAULT_CORS_ALLOWED_ORIGINS);
  });
});
