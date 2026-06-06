type CorsOriginCallback = (error: Error | null, allow?: boolean) => void;
export type CorsOriginDelegate = (
  origin: string | undefined,
  callback: CorsOriginCallback,
) => void;

type CorsOriginMatcher = string | RegExp;

export const DEFAULT_CORS_ALLOWED_ORIGINS: CorsOriginMatcher[] = [
  'http://localhost:3000',
  /\.localhost:3000$/,
  /^https?:\/\/([a-zA-Z0-9-]+\.)*topcoder-dev\.com(:\d+)?$/,
  /^https?:\/\/([a-zA-Z0-9-]+\.)*topcoder\.com(:\d+)?$/,
];

/**
 * Creates the CORS origin delegate for the CORS_ALLOWED_ORIGIN environment value.
 *
 * @param allowedOrigin The full browser Origin value allowed by configuration.
 * @returns A delegate that allows only exact matches for the configured origin.
 */
export function buildConfiguredCorsOrigin(
  allowedOrigin: string,
): CorsOriginDelegate {
  const allowedOriginValue = allowedOrigin.trim();

  return (origin, callback) => {
    callback(null, origin === allowedOriginValue);
  };
}

/**
 * Builds the CORS origin option used by the application bootstrap.
 *
 * @param allowedOrigin Optional CORS_ALLOWED_ORIGIN environment value.
 * @returns Exact configured origin matching when set, otherwise the built-in allowlist.
 */
export function buildCorsOrigin(
  allowedOrigin?: string,
): CorsOriginDelegate | CorsOriginMatcher[] {
  const allowedOriginValue = allowedOrigin?.trim();

  return allowedOriginValue
    ? buildConfiguredCorsOrigin(allowedOriginValue)
    : DEFAULT_CORS_ALLOWED_ORIGINS;
}
