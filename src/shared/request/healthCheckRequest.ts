const HEALTH_CHECK_PATHS = new Set(['/health', '/v6/marathon-match/health']);

/**
 * Identifies requests for this service's health endpoint so high-frequency
 * load balancer checks can bypass normal access logging.
 *
 * @param url - Express request URL, path, or originalUrl, with or without a query string.
 * @returns True only when the URL resolves to this service's health endpoint.
 * @throws This function does not throw; missing or invalid URLs return false.
 */
export function isHealthCheckRequestUrl(url?: string): boolean {
  if (!url) {
    return false;
  }

  const [path] = url.split('?');
  const normalizedPath = path.length > 1 ? path.replace(/\/+$/, '') : path;

  return HEALTH_CHECK_PATHS.has(normalizedPath);
}
