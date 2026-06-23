import { BadRequestException } from '@nestjs/common';

const defaultTopcoderDevApiUrl = 'https://api.topcoder-dev.com';

interface ResolveSubmissionApiUrlOptions {
  configuredUrl?: string | null;
  environmentUrls?: Array<string | null | undefined>;
  fallbackApiBaseUrl?: string | null;
}

/**
 * Resolves the Submission API base URL used by Marathon Match services.
 * Prefers the deployment-wide SUBMISSION_API_URL override, then the persisted
 * challenge config value, then a default derived from CHALLENGE_API_URL.
 */
export function resolveSubmissionApiBaseUrl(
  options: ResolveSubmissionApiUrlOptions = {},
): string {
  const configuredUrl = normalizeOptionalUrl(options.configuredUrl);
  const envUrl = normalizeOptionalUrl(process.env.SUBMISSION_API_URL);
  const fallbackUrl = buildDefaultSubmissionApiBaseUrl(
    options.fallbackApiBaseUrl,
  );
  const resolvedUrl = normalizeSubmissionApiBaseUrl(
    envUrl || configuredUrl || fallbackUrl,
  );

  validateSubmissionApiBaseUrl(resolvedUrl, options.environmentUrls);
  return resolvedUrl;
}

/**
 * Resolves the persisted Submission API URL for newly created configs.
 * Unlike runtime reads, caller-supplied input wins so explicit bad prod values
 * are rejected instead of hidden by SUBMISSION_API_URL.
 */
export function resolvePersistedSubmissionApiBaseUrl(
  configuredUrl?: string | null,
  fallbackApiBaseUrl?: string | null,
): string {
  const resolvedUrl = normalizeSubmissionApiBaseUrl(
    normalizeOptionalUrl(configuredUrl) ||
      normalizeOptionalUrl(process.env.SUBMISSION_API_URL) ||
      buildDefaultSubmissionApiBaseUrl(fallbackApiBaseUrl),
  );

  validateSubmissionApiBaseUrl(resolvedUrl, [fallbackApiBaseUrl]);
  return resolvedUrl;
}

export function normalizeSubmissionApiBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function buildDefaultSubmissionApiBaseUrl(
  fallbackApiBaseUrl?: string | null,
): string {
  const topcoderApiBaseUrl =
    normalizeOptionalUrl(fallbackApiBaseUrl) ||
    normalizeOptionalUrl(process.env.CHALLENGE_API_URL) ||
    defaultTopcoderDevApiUrl;

  if (topcoderApiBaseUrl.endsWith('/v6')) {
    return topcoderApiBaseUrl;
  }

  return `${topcoderApiBaseUrl}/v6`;
}

function validateSubmissionApiBaseUrl(
  submissionApiUrl: string,
  environmentUrls?: Array<string | null | undefined>,
): void {
  if (!submissionApiUrl) {
    throw new BadRequestException('Submission API URL is not configured.');
  }

  const parsedUrl = parseUrl(submissionApiUrl);
  if (!parsedUrl) {
    throw new BadRequestException(
      `Submission API URL is invalid: ${submissionApiUrl}`,
    );
  }

  const normalizedPath = parsedUrl.pathname.replace(/\/+$/, '').toLowerCase();
  if (
    normalizedPath === '/v6/submissions' ||
    normalizedPath.endsWith('/submissions')
  ) {
    throw new BadRequestException(
      'SUBMISSION_API_URL must be the API base URL, for example https://api.topcoder.com/v6, not the /submissions collection URL.',
    );
  }

  if (
    isTopcoderProdEnvironment(environmentUrls) &&
    isTopcoderDevHost(parsedUrl.hostname)
  ) {
    throw new BadRequestException(
      'Production Topcoder Marathon Match must not use topcoder-dev Submission API URLs. Set SUBMISSION_API_URL=https://api.topcoder.com/v6 and update persisted marathonMatchConfig.submissionApiUrl values.',
    );
  }
}

function isTopcoderProdEnvironment(
  environmentUrls?: Array<string | null | undefined>,
): boolean {
  const urls = [
    ...(environmentUrls ?? []),
    process.env.CHALLENGE_API_URL,
    process.env.MARATHON_MATCH_API_URL,
    process.env.REVIEW_API_URL,
  ];

  return urls.some((url) => {
    const parsedUrl = parseUrl(url);
    return parsedUrl?.hostname.toLowerCase() === 'api.topcoder.com';
  });
}

function isTopcoderDevHost(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  return (
    normalizedHostname === 'api.topcoder-dev.com' ||
    normalizedHostname.endsWith('.topcoder-dev.com')
  );
}

function normalizeOptionalUrl(url?: string | null): string | undefined {
  const normalizedUrl = url?.trim().replace(/\/+$/, '');
  return normalizedUrl || undefined;
}

function parseUrl(url?: string | null): URL | undefined {
  const normalizedUrl = normalizeOptionalUrl(url);
  if (!normalizedUrl) {
    return undefined;
  }

  try {
    return new URL(normalizedUrl);
  } catch {
    return undefined;
  }
}
