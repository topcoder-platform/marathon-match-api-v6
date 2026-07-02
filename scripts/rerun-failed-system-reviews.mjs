#!/usr/bin/env node

import { chmod, readFile, writeFile } from 'node:fs/promises';

const DEFAULT_API_BASE = 'https://api.topcoder.com/v6';
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_PER_PAGE = 100;
const DEFAULT_MAX_DISPATCHES = 20;
const COMPLETED_REVIEW_STATUS = 'COMPLETED';
const IGNORED_REVIEW_STATUSES = new Set(['CANCELLED', 'DELETED']);

/**
 * Error type that preserves failed API response details for retry and logging.
 */
class ApiError extends Error {
  /**
   * Creates an API error.
   * @param {string} message Human-readable request failure message.
   * @param {number} status HTTP status code.
   * @param {unknown} body Parsed response body or response text.
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Prints usage information and exits.
 * @returns {never} This function always exits the process.
 */
function printUsageAndExit() {
  console.log(`Usage:
  node scripts/rerun-failed-system-reviews.mjs --challenge-id <id> [options]

Required:
  --challenge-id <id>           Marathon Match challenge ID. Can also use CHALLENGE_ID.
  --token <jwt>                 Admin/M2M bearer token. Can also use TOKEN or AUTH_TOKEN.

API options:
  --api-base <url>              Shared v6 API base. Default: ${DEFAULT_API_BASE}
  --mm-api-base <url>           Marathon Match API base. Default: <api-base>/marathon-match
  --review-api-base <url>       Review API base. Default: <api-base>
  --scorecard-id <id[,id...]>   Override/augment scorecard IDs used to identify SYSTEM reviews.
  --per-page <n>                Review API page size. Default: ${DEFAULT_PER_PAGE}

Selection options:
  --expected-tests <n>          Require successful summations to report at least n completed tests.
  --include-non-completed <bool> Select reviews whose review status is not COMPLETED. Default: true
  --include-missing-summation <bool> Select reviews with no SYSTEM summation. Default: true
  --include-failed-summation <bool> Select FAILED system summations. Default: true
  --include-in-progress-summation <bool> Select IN PROGRESS or incomplete system summations. Default: true
  --include-unknown-summation <bool> Select system summations without SUCCESS status. Default: true

Dispatch/output options:
  --dispatch                    Dispatch selected reruns now. Default: false; writes files only.
  --max-dispatches <n>          Max accepted dispatches per script run. 0 means unlimited. Default: ${DEFAULT_MAX_DISPATCHES}
  --retry-delay-ms <ms>         Delay before retrying when the ECS cap is full. Default: ${DEFAULT_RETRY_DELAY_MS}
  --max-cap-retries <n>         Stop after n cap retries. Default: unlimited.
  --retry-internal-500 <bool>   Treat generic /internal/system-score HTTP 500s as retryable. Default: true
  --state-file <path>           State JSON file. Default: failed-system-rerun-<challengeId>-<timestamp>.json
  --commands-file <path>        Generated shell rerun file. Default: failed-system-rerun-<challengeId>-<timestamp>.sh
  --resume-state <path>         Resume dispatch from a previous state file. Requires --dispatch to launch.
`);
  process.exit(0);
}

/**
 * Parses command-line arguments into camel-case option keys.
 * @param {string[]} argv Raw process arguments after the script name.
 * @returns {Record<string, string | boolean>} Parsed CLI options.
 */
function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const raw = argv[index];
    if (raw === '--') {
      continue;
    }

    if (raw === '--help' || raw === '-h') {
      printUsageAndExit();
    }

    if (!raw.startsWith('--')) {
      throw new Error(`Unexpected positional argument: ${raw}`);
    }

    const withoutPrefix = raw.slice(2);
    const equalsIndex = withoutPrefix.indexOf('=');
    if (equalsIndex >= 0) {
      args[toCamelCase(withoutPrefix.slice(0, equalsIndex))] =
        withoutPrefix.slice(equalsIndex + 1);
      continue;
    }

    const key = toCamelCase(withoutPrefix);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[key] = true;
      continue;
    }

    args[key] = next;
    index += 1;
  }

  return args;
}

/**
 * Converts a kebab-case option name into camelCase.
 * @param {string} value CLI option name without leading dashes.
 * @returns {string} Camel-case option name.
 */
function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Builds validated runtime configuration from CLI options and environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI options.
 * @returns {Record<string, unknown>} Runtime configuration for the script.
 */
function buildRuntimeConfig(args) {
  const apiBase = stripTrailingSlash(
    getStringOption(args, 'apiBase', ['API_BASE'], DEFAULT_API_BASE),
  );
  const challengeId = getStringOption(args, 'challengeId', ['CHALLENGE_ID']);
  const mmApiBase = stripTrailingSlash(
    getStringOption(
      args,
      'mmApiBase',
      ['MM_API_BASE'],
      joinUrl(apiBase, 'marathon-match'),
    ),
  );
  const reviewApiBase = normalizeV6Base(
    getStringOption(args, 'reviewApiBase', ['REVIEW_API_BASE'], apiBase),
  );
  const token = getStringOption(args, 'token', ['TOKEN', 'AUTH_TOKEN']);
  const retryDelayMs = getIntegerOption(
    args,
    'retryDelayMs',
    ['FAILED_SYSTEM_RERUN_RETRY_DELAY_MS'],
    DEFAULT_RETRY_DELAY_MS,
  );
  const maxCapRetries = getIntegerOption(
    args,
    'maxCapRetries',
    ['FAILED_SYSTEM_RERUN_MAX_CAP_RETRIES'],
    0,
  );
  const maxDispatches = getIntegerOption(
    args,
    'maxDispatches',
    ['FAILED_SYSTEM_RERUN_MAX_DISPATCHES'],
    DEFAULT_MAX_DISPATCHES,
  );
  const perPage = getIntegerOption(
    args,
    'perPage',
    ['FAILED_SYSTEM_RERUN_PER_PAGE'],
    DEFAULT_PER_PAGE,
  );
  const expectedTestsRaw = getStringOption(args, 'expectedTests', [
    'FAILED_SYSTEM_RERUN_EXPECTED_TESTS',
  ]);
  const expectedTests =
    expectedTestsRaw === undefined
      ? undefined
      : Number.parseInt(expectedTestsRaw, 10);
  const dispatch = getBooleanOption(
    args,
    'dispatch',
    ['FAILED_SYSTEM_RERUN_DISPATCH'],
    false,
  );
  const retryInternal500 = getBooleanOption(
    args,
    'retryInternal500',
    ['FAILED_SYSTEM_RERUN_RETRY_INTERNAL_500'],
    true,
  );
  const includeNonCompleted = getBooleanOption(
    args,
    'includeNonCompleted',
    ['FAILED_SYSTEM_RERUN_INCLUDE_NON_COMPLETED'],
    true,
  );
  const includeMissingSummation = getBooleanOption(
    args,
    'includeMissingSummation',
    ['FAILED_SYSTEM_RERUN_INCLUDE_MISSING_SUMMATION'],
    true,
  );
  const includeFailedSummation = getBooleanOption(
    args,
    'includeFailedSummation',
    ['FAILED_SYSTEM_RERUN_INCLUDE_FAILED_SUMMATION'],
    true,
  );
  const includeInProgressSummation = getBooleanOption(
    args,
    'includeInProgressSummation',
    ['FAILED_SYSTEM_RERUN_INCLUDE_IN_PROGRESS_SUMMATION'],
    true,
  );
  const includeUnknownSummation = getBooleanOption(
    args,
    'includeUnknownSummation',
    ['FAILED_SYSTEM_RERUN_INCLUDE_UNKNOWN_SUMMATION'],
    true,
  );
  const resumeState = getStringOption(args, 'resumeState', [
    'FAILED_SYSTEM_RERUN_RESUME_STATE',
  ]);
  const explicitScorecardIds = splitCsv(
    getStringOption(args, 'scorecardId', ['FAILED_SYSTEM_RERUN_SCORECARD_ID']),
  );

  if (!challengeId) {
    throw new Error('--challenge-id or CHALLENGE_ID is required.');
  }

  if (!token) {
    throw new Error('--token, TOKEN, or AUTH_TOKEN is required.');
  }

  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 1000) {
    throw new Error('--retry-delay-ms must be an integer >= 1000.');
  }

  if (!Number.isInteger(maxCapRetries) || maxCapRetries < 0) {
    throw new Error('--max-cap-retries must be 0 or a positive integer.');
  }

  if (!Number.isInteger(maxDispatches) || maxDispatches < 0) {
    throw new Error('--max-dispatches must be 0 or a positive integer.');
  }

  if (!Number.isInteger(perPage) || perPage < 1 || perPage > 500) {
    throw new Error('--per-page must be an integer from 1 through 500.');
  }

  if (
    expectedTests !== undefined &&
    (!Number.isInteger(expectedTests) || expectedTests < 1)
  ) {
    throw new Error('--expected-tests must be a positive integer.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stateFile = getStringOption(
    args,
    'stateFile',
    ['FAILED_SYSTEM_RERUN_STATE_FILE'],
    resumeState ?? `failed-system-rerun-${challengeId}-${timestamp}.json`,
  );
  const commandsFile = getStringOption(
    args,
    'commandsFile',
    ['FAILED_SYSTEM_RERUN_COMMANDS_FILE'],
    `failed-system-rerun-${challengeId}-${timestamp}.sh`,
  );

  return {
    apiBase,
    challengeId,
    commandsFile,
    dispatch,
    expectedTests,
    explicitScorecardIds,
    includeFailedSummation,
    includeInProgressSummation,
    includeMissingSummation,
    includeNonCompleted,
    includeUnknownSummation,
    maxCapRetries,
    maxDispatches,
    mmApiBase,
    perPage,
    retryDelayMs,
    retryInternal500,
    resumeState,
    reviewApiBase,
    stateFile,
    token,
  };
}

/**
 * Reads a string option from CLI args, environment variables, or default value.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI option key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {string | undefined} defaultValue Default value.
 * @returns {string | undefined} Resolved string value.
 */
function getStringOption(args, key, envNames = [], defaultValue = undefined) {
  const argValue = args[key];
  if (typeof argValue === 'string' && argValue.trim()) {
    return argValue.trim();
  }

  for (const envName of envNames) {
    const envValue = process.env[envName];
    if (typeof envValue === 'string' && envValue.trim()) {
      return envValue.trim();
    }
  }

  return defaultValue;
}

/**
 * Reads and validates an integer option.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI option key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {number} defaultValue Default integer value.
 * @returns {number} Parsed integer.
 */
function getIntegerOption(args, key, envNames, defaultValue) {
  const raw = getStringOption(args, key, envNames, String(defaultValue));
  const parsed = Number.parseInt(raw ?? '', 10);
  if (!Number.isInteger(parsed)) {
    throw new Error(`Option ${key} must be an integer.`);
  }

  return parsed;
}

/**
 * Reads and validates a boolean option.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI option key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {boolean} defaultValue Default boolean value.
 * @returns {boolean} Parsed boolean.
 */
function getBooleanOption(args, key, envNames, defaultValue) {
  if (typeof args[key] === 'boolean') {
    return args[key];
  }

  const raw = getStringOption(args, key, envNames);
  if (raw === undefined) {
    return defaultValue;
  }

  const normalized = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'n'].includes(normalized)) {
    return false;
  }

  throw new Error(`Option ${key} must be a boolean.`);
}

/**
 * Splits a comma-delimited option into non-empty trimmed values.
 * @param {string | undefined} value Raw CSV text.
 * @returns {string[]} Parsed values.
 */
function splitCsv(value) {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * Removes trailing slashes from a URL string.
 * @param {string | undefined} value Raw URL.
 * @returns {string} URL without trailing slashes.
 */
function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * Normalizes a Topcoder API base to a v6 base URL.
 * @param {string | undefined} value Raw configured base URL.
 * @returns {string} Base URL ending at `/v6`.
 */
function normalizeV6Base(value) {
  const stripped = stripTrailingSlash(value).replace(
    /\/(reviewSummations|reviews|scorecards)$/,
    '',
  );
  return stripped.endsWith('/v6') ? stripped : joinUrl(stripped, 'v6');
}

/**
 * Joins URL path segments without duplicating slashes.
 * @param {...string} parts URL segments.
 * @returns {string} Joined URL.
 */
function joinUrl(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && String(part))
    .map((part, index) => {
      const value = String(part);
      if (index === 0) {
        return value.replace(/\/+$/, '');
      }

      return value.replace(/^\/+|\/+$/g, '');
    })
    .join('/');
}

/**
 * Parses an HTTP response as JSON, falling back to raw text.
 * @param {Response} response Fetch response.
 * @returns {Promise<unknown>} Parsed response body.
 */
async function parseResponse(response) {
  const text = await response.text();
  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Performs an authenticated JSON request.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {string} url Request URL.
 * @param {Record<string, unknown>} options Fetch options.
 * @returns {Promise<unknown>} Parsed successful response.
 * @throws {ApiError} When the API returns a non-2xx response.
 */
async function requestJson(runtime, url, options = {}) {
  const headers = {
    Authorization: `Bearer ${runtime.token}`,
    Accept: 'application/json',
    ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers ?? {}),
  };
  const response = await fetch(url, {
    ...options,
    headers,
    body:
      options.body !== undefined && typeof options.body !== 'string'
        ? JSON.stringify(options.body)
        : options.body,
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(
      `Request failed: ${options.method ?? 'GET'} ${url}`,
      response.status,
      body,
    );
  }

  return body;
}

/**
 * Fetches the Marathon Match config so the script can infer the configured review scorecard.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Config response body as a record.
 */
async function fetchMarathonMatchConfig(runtime) {
  const data = await requestJson(
    runtime,
    joinUrl(runtime.mmApiBase, 'challenge', runtime.challengeId),
  );
  return asRecord(data);
}

/**
 * Resolves scorecard identifiers from config and CLI overrides.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} config Marathon Match config response.
 * @returns {Promise<Set<string>>} Accepted scorecard identifiers.
 */
async function resolveScorecardIds(runtime, config) {
  const scorecardIds = new Set(runtime.explicitScorecardIds);
  const configuredScorecardId = asNonEmptyString(config.reviewScorecardId);
  if (configuredScorecardId) {
    scorecardIds.add(configuredScorecardId);
  }

  for (const scorecardId of Array.from(scorecardIds)) {
    try {
      const scorecard = await requestJson(
        runtime,
        joinUrl(runtime.reviewApiBase, 'scorecards', encodeURIComponent(scorecardId)),
      );
      for (const resolvedId of extractScorecardIds(scorecard)) {
        scorecardIds.add(resolvedId);
      }
    } catch (error) {
      console.warn(
        `Unable to resolve scorecard ${scorecardId}; keeping the original identifier. ${getErrorMessage(error)}`,
      );
    }
  }

  return scorecardIds;
}

/**
 * Extracts possible scorecard identifiers from a Review API scorecard response.
 * @param {unknown} value Scorecard response body.
 * @returns {string[]} Candidate scorecard IDs.
 */
function extractScorecardIds(value) {
  const record = asRecord(value);
  const nested = asRecord(record.result);
  const candidates = [
    record.id,
    record.legacyId,
    record.scorecardId,
    record.scoreCardId,
    nested.id,
    nested.legacyId,
    nested.scorecardId,
    nested.scoreCardId,
  ];

  return candidates.map(asNonEmptyString).filter(Boolean);
}

/**
 * Fetches all Review API reviews for the challenge.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @returns {Promise<Record<string, unknown>[]>} Review records.
 */
async function fetchChallengeReviews(runtime) {
  const reviews = [];
  let page = 1;
  let totalPages = 1;

  do {
    const url = withQuery(joinUrl(runtime.reviewApiBase, 'reviews'), {
      challengeId: runtime.challengeId,
      page,
      perPage: runtime.perPage,
      thin: 'true',
    });
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        Accept: 'application/json',
      },
    });
    const body = await parseResponse(response);
    if (!response.ok) {
      throw new ApiError(`Request failed: GET ${url}`, response.status, body);
    }

    const pageReviews = extractArray(body);
    reviews.push(...pageReviews);
    totalPages = resolveTotalPages(body, response.headers, runtime.perPage);
    page += 1;
  } while (page <= totalPages);

  return reviews;
}

/**
 * Fetches SYSTEM review summations for a submission.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {string} submissionId Submission ID to inspect.
 * @returns {Promise<Record<string, unknown>[]>} Matching summations.
 */
async function fetchSystemSummations(runtime, submissionId) {
  const url = withQuery(joinUrl(runtime.reviewApiBase, 'reviewSummations'), {
    metadata: 'true',
    submissionId,
    system: 'true',
  });
  const data = await requestJson(runtime, url);
  return extractArray(data).filter(matchesSystemSummation);
}

/**
 * Adds query parameters to a URL.
 * @param {string} url Base URL.
 * @param {Record<string, string | number | undefined>} params Query parameters.
 * @returns {string} URL with query string.
 */
function withQuery(url, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }

  const queryString = query.toString();
  return queryString ? `${url}?${queryString}` : url;
}

/**
 * Extracts an array from common Topcoder API response envelopes.
 * @param {unknown} data API response body.
 * @returns {Record<string, unknown>[]} Extracted records.
 */
function extractArray(data) {
  if (Array.isArray(data)) {
    return data.map(asRecord);
  }

  const wrapper = asRecord(data);
  if (Array.isArray(wrapper.data)) {
    return wrapper.data.map(asRecord);
  }

  const result = asRecord(wrapper.result);
  if (Array.isArray(result.content)) {
    return result.content.map(asRecord);
  }

  if (Array.isArray(result.data)) {
    return result.data.map(asRecord);
  }

  return [];
}

/**
 * Resolves total pages from response body or pagination headers.
 * @param {unknown} body API response body.
 * @param {Headers} headers Fetch response headers.
 * @param {number} fallbackPerPage Requested page size.
 * @returns {number} Total pages to fetch.
 */
function resolveTotalPages(body, headers, fallbackPerPage) {
  const headerTotalPages = parsePositiveInteger(
    getHeader(headers, 'x-total-pages', 'x-total-page', 'total-pages'),
  );
  if (headerTotalPages) {
    return headerTotalPages;
  }

  const headerTotal = parseNonNegativeInteger(getHeader(headers, 'x-total', 'total'));
  if (headerTotal !== undefined) {
    return Math.max(1, Math.ceil(headerTotal / fallbackPerPage));
  }

  const candidates = [
    asRecord(body),
    asRecord(asRecord(body).metadata),
    asRecord(asRecord(body).pagination),
    asRecord(asRecord(body).result),
    asRecord(asRecord(asRecord(body).result).metadata),
    asRecord(asRecord(asRecord(body).result).pagination),
  ];
  for (const candidate of candidates) {
    const totalPages = parsePositiveInteger(
      readCaseInsensitive(candidate, 'totalPages', 'totalPage', 'pageCount'),
    );
    if (totalPages) {
      return totalPages;
    }
  }

  return 1;
}

/**
 * Reads one response header using case-insensitive names.
 * @param {Headers} headers Fetch response headers.
 * @param {...string} names Header names.
 * @returns {string | undefined} Header value.
 */
function getHeader(headers, ...names) {
  for (const name of names) {
    const value = headers.get(name);
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Reads a record field using case-insensitive fallback names.
 * @param {Record<string, unknown>} record Source record.
 * @param {...string} names Candidate field names.
 * @returns {unknown} Field value when present.
 */
function readCaseInsensitive(record, ...names) {
  for (const name of names) {
    if (Object.prototype.hasOwnProperty.call(record, name)) {
      return record[name];
    }

    const lowerName = name.toLowerCase();
    for (const [key, value] of Object.entries(record)) {
      if (key.toLowerCase() === lowerName) {
        return value;
      }
    }
  }

  return undefined;
}

/**
 * Converts Review API reviews into SYSTEM review candidates matching the scorecard.
 * @param {Record<string, unknown>[]} reviews Review records.
 * @param {Set<string>} scorecardIds Accepted scorecard IDs.
 * @returns {Array<Record<string, unknown>>} Review/submission candidate records.
 */
function getSystemReviewCandidates(reviews, scorecardIds) {
  const candidates = [];
  const seenReviewIds = new Set();

  for (const review of reviews) {
    const reviewId = asNonEmptyString(review.id);
    const submissionId = asNonEmptyString(review.submissionId);
    if (!reviewId || !submissionId || seenReviewIds.has(reviewId)) {
      continue;
    }

    const reviewStatus = normalizeStatus(review.status);
    if (IGNORED_REVIEW_STATUSES.has(reviewStatus)) {
      continue;
    }

    const scorecardId =
      asNonEmptyString(review.scorecardId) ?? asNonEmptyString(review.scoreCardId);
    if (scorecardIds.size > 0 && (!scorecardId || !scorecardIds.has(scorecardId))) {
      continue;
    }

    seenReviewIds.add(reviewId);
    candidates.push({
      reviewId,
      reviewStatus,
      scorecardId,
      submissionId,
    });
  }

  return candidates.sort((left, right) =>
    left.submissionId === right.submissionId
      ? left.reviewId.localeCompare(right.reviewId)
      : left.submissionId.localeCompare(right.submissionId),
  );
}

/**
 * Selects candidates that need rerun based on review and summation state.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Array<Record<string, unknown>>} candidates SYSTEM review candidates.
 * @returns {Promise<{selected: Array<Record<string, unknown>>, skipped: Array<Record<string, unknown>>}>} Selection result.
 */
async function selectFailedCandidates(runtime, candidates) {
  const selected = [];
  const skipped = [];

  for (const candidate of candidates) {
    const summations = await fetchSystemSummations(runtime, candidate.submissionId);
    const decision = classifyCandidate(runtime, candidate, summations);
    const record = {
      ...candidate,
      reason: decision.reason,
      summation: summarizeSummation(decision.summation),
    };

    if (decision.selected) {
      selected.push(record);
    } else {
      skipped.push(record);
    }
  }

  return { selected, skipped };
}

/**
 * Determines whether one candidate should be rerun.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} candidate Review/submission candidate.
 * @param {Record<string, unknown>[]} summations System summations for the submission.
 * @returns {{selected: boolean, reason: string, summation?: Record<string, unknown>}} Decision.
 */
function classifyCandidate(runtime, candidate, summations) {
  const bestSummation = chooseMostRecentSummation(summations);
  const successfulSummation = summations.find((summation) =>
    isSuccessfulSummation(runtime, summation),
  );
  const reviewStatus = normalizeStatus(candidate.reviewStatus);

  if (
    runtime.includeNonCompleted &&
    reviewStatus &&
    reviewStatus !== COMPLETED_REVIEW_STATUS
  ) {
    return {
      selected: true,
      reason: `review status is ${reviewStatus}`,
      summation: bestSummation,
    };
  }

  if (summations.length === 0) {
    return {
      selected: Boolean(runtime.includeMissingSummation),
      reason: 'missing SYSTEM review summation',
    };
  }

  if (
    successfulSummation &&
    (!reviewStatus || reviewStatus === COMPLETED_REVIEW_STATUS)
  ) {
    return {
      selected: false,
      reason: 'completed review with successful SYSTEM summation',
      summation: successfulSummation,
    };
  }

  const status = getSummationTestStatus(bestSummation);
  const progressComplete = isProgressComplete(runtime, bestSummation);
  if (status === 'FAILED') {
    return {
      selected: Boolean(runtime.includeFailedSummation),
      reason: 'SYSTEM summation testStatus is FAILED',
      summation: bestSummation,
    };
  }

  if (status === 'IN PROGRESS' || !progressComplete) {
    return {
      selected: Boolean(runtime.includeInProgressSummation),
      reason: 'SYSTEM summation is still in progress or incomplete',
      summation: bestSummation,
    };
  }

  return {
    selected: Boolean(runtime.includeUnknownSummation),
    reason: status
      ? `SYSTEM summation testStatus is ${status}`
      : 'SYSTEM summation has no SUCCESS testStatus',
    summation: bestSummation,
  };
}

/**
 * Checks whether a summation is a successful completed SYSTEM summation.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} summation Review summation record.
 * @returns {boolean} True when no rerun is needed for this summation.
 */
function isSuccessfulSummation(runtime, summation) {
  return getSummationTestStatus(summation) === 'SUCCESS' &&
    isProgressComplete(runtime, summation);
}

/**
 * Checks whether a summation belongs to SYSTEM scoring.
 * @param {Record<string, unknown>} summation Review summation record.
 * @returns {boolean} True when the summation is for SYSTEM scoring.
 */
function matchesSystemSummation(summation) {
  const metadata = asRecord(summation.metadata);
  const metadataTestType = normalizePhase(metadata.testType);
  const metadataTestProcess = normalizePhase(metadata.testProcess);
  const metadataStage = asNonEmptyString(metadata.stage)?.toLowerCase();

  return parseBooleanFlag(summation.isFinal) === true ||
    metadataTestType === 'system' ||
    metadataTestProcess === 'system' ||
    metadataStage === 'final';
}

/**
 * Reads the normalized test status from summation metadata.
 * @param {Record<string, unknown> | undefined} summation Review summation record.
 * @returns {string | undefined} Upper-case test status.
 */
function getSummationTestStatus(summation) {
  const metadata = asRecord(summation?.metadata);
  const details = asRecord(metadata.testProgressDetails);
  return normalizeStatus(metadata.testStatus ?? details.status);
}

/**
 * Checks whether progress metadata reports a completed system run.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown> | undefined} summation Review summation record.
 * @returns {boolean} True when progress and completed-test counts are complete.
 */
function isProgressComplete(runtime, summation) {
  const metadata = asRecord(summation?.metadata);
  const details = asRecord(metadata.testProgressDetails);
  const progress = toNumber(metadata.testProgress ?? details.progress);
  const completedTests =
    toNumber(details.completedTests) ??
    countArray(metadata.testScores) ??
    toNumber(metadata.completedTests);
  const totalTests =
    runtime.expectedTests ??
    toNumber(details.totalTests) ??
    toNumber(asRecord(metadata.tests).total) ??
    toNumber(metadata.numberOfTests);

  if (progress !== undefined && progress < 1) {
    return false;
  }

  if (totalTests !== undefined) {
    return completedTests !== undefined && completedTests >= totalTests;
  }

  return true;
}

/**
 * Chooses the newest summation based on common timestamp fields.
 * @param {Record<string, unknown>[]} summations Review summations.
 * @returns {Record<string, unknown> | undefined} Most recent summation.
 */
function chooseMostRecentSummation(summations) {
  return [...summations].sort((left, right) =>
    getTimestamp(right) - getTimestamp(left),
  )[0];
}

/**
 * Converts a record timestamp to milliseconds since epoch.
 * @param {Record<string, unknown>} record Source record.
 * @returns {number} Parsed timestamp or zero.
 */
function getTimestamp(record) {
  const raw =
    asNonEmptyString(record.updatedAt) ??
    asNonEmptyString(record.updated) ??
    asNonEmptyString(record.reviewedDate) ??
    asNonEmptyString(record.createdAt);
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Builds a compact summation summary for state files.
 * @param {Record<string, unknown> | undefined} summation Review summation record.
 * @returns {Record<string, unknown> | undefined} Serializable summary.
 */
function summarizeSummation(summation) {
  if (!summation) {
    return undefined;
  }

  const metadata = asRecord(summation.metadata);
  const details = asRecord(metadata.testProgressDetails);
  return {
    id: asNonEmptyString(summation.id),
    aggregateScore: toNumber(summation.aggregateScore ?? summation.score),
    isFinal: parseBooleanFlag(summation.isFinal),
    reviewedDate: asNonEmptyString(summation.reviewedDate),
    testStatus: getSummationTestStatus(summation),
    testProgress: toNumber(metadata.testProgress ?? details.progress),
    completedTests:
      toNumber(details.completedTests) ??
      countArray(metadata.testScores) ??
      toNumber(metadata.completedTests),
    totalTests:
      toNumber(details.totalTests) ??
      toNumber(asRecord(metadata.tests).total) ??
      toNumber(metadata.numberOfTests),
    failedTests:
      toNumber(details.failedTests) ??
      toNumber(asRecord(metadata.tests).failed) ??
      toNumber(metadata.failedTests),
    timedOut: parseBooleanFlag(metadata.timed_out ?? metadata.timedOut),
  };
}

/**
 * Writes script state as formatted JSON.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} state State object to write.
 * @returns {Promise<void>} Resolves after writing the state file.
 */
async function writeState(runtime, state) {
  await writeFile(runtime.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Writes a shell script containing one rerun curl command per candidate.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Array<Record<string, unknown>>} candidates Selected rerun candidates.
 * @returns {Promise<void>} Resolves after writing and chmodding the shell script.
 */
async function writeCommandsFile(runtime, candidates) {
  const lines = [
    '#!/usr/bin/env bash',
    'set -euo pipefail',
    '',
    ': "${TOKEN:?Set TOKEN to an admin/M2M bearer token}"',
    `MM_API_BASE="\${MM_API_BASE:-${runtime.mmApiBase}}"`,
    'DELAY_SECONDS="${FAILED_SYSTEM_RERUN_DELAY_SECONDS:-0}"',
    `MAX_DISPATCHES="\${FAILED_SYSTEM_RERUN_MAX_DISPATCHES:-${runtime.maxDispatches}}"`,
    'DISPATCHED=0',
    '',
  ];

  for (const candidate of candidates) {
    const payload = JSON.stringify({
      challengeId: runtime.challengeId,
      reviewId: candidate.reviewId,
      submissionId: candidate.submissionId,
    });
    lines.push(
      'if [[ "$MAX_DISPATCHES" != "0" && "$DISPATCHED" -ge "$MAX_DISPATCHES" ]]; then',
      '  echo "Reached FAILED_SYSTEM_RERUN_MAX_DISPATCHES=$MAX_DISPATCHES. Re-run this script later for remaining commands."',
      '  exit 0',
      'fi',
      `echo "Dispatching review ${candidate.reviewId} for submission ${candidate.submissionId}"`,
      `curl -fsS -X POST "$MM_API_BASE/internal/system-score" -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" --data ${shellQuote(payload)}`,
      'DISPATCHED=$((DISPATCHED + 1))',
      'if [[ "$DELAY_SECONDS" != "0" ]]; then sleep "$DELAY_SECONDS"; fi',
      '',
    );
  }

  await writeFile(runtime.commandsFile, `${lines.join('\n')}\n`);
  await chmod(runtime.commandsFile, 0o755);
}

/**
 * Shell-quotes one string for POSIX shell usage.
 * @param {string} value Raw string.
 * @returns {string} Single-quoted shell literal.
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Dispatches one known review/submission pair through the single SYSTEM endpoint.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {{reviewId: string, submissionId: string}} candidate Rerun candidate.
 * @returns {Promise<void>} Resolves after the API accepts dispatch.
 */
async function dispatchSingleSystemReview(runtime, candidate) {
  await requestJson(runtime, joinUrl(runtime.mmApiBase, 'internal/system-score'), {
    method: 'POST',
    body: {
      challengeId: runtime.challengeId,
      reviewId: candidate.reviewId,
      submissionId: candidate.submissionId,
    },
  });
}

/**
 * Drains pending candidates, retrying capacity back-pressure.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} state Mutable persisted state.
 * @returns {Promise<void>} Resolves after all pending candidates are handled.
 */
async function drainPending(runtime, state) {
  let capRetryCount = 0;
  let acceptedDispatches = 0;

  while (state.pending.length > 0) {
    if (hasReachedDispatchLimit(runtime, acceptedDispatches)) {
      state.pausedAt = new Date().toISOString();
      state.pauseReason = `Reached max dispatches for this run: ${runtime.maxDispatches}.`;
      state.lastDispatchRunAcceptedCount = acceptedDispatches;
      await writeState(runtime, state);
      console.log(
        `${state.pauseReason} Pending=${state.pending.length}. Resume later with --resume-state ${runtime.stateFile} --dispatch.`,
      );
      break;
    }

    const candidate = state.pending[0];
    console.log(
      `Dispatching failed SYSTEM review ${candidate.reviewId} for submission ${candidate.submissionId}. Pending=${state.pending.length}`,
    );

    try {
      await dispatchSingleSystemReview(runtime, candidate);
      state.pending.shift();
      state.launched.push({
        ...candidate,
        launchedBy: 'internal/system-score',
        launchedAt: new Date().toISOString(),
      });
      acceptedDispatches += 1;
      state.lastDispatchRunAcceptedCount = acceptedDispatches;
      await writeState(runtime, state);
      capRetryCount = 0;
    } catch (error) {
      const message = getErrorMessage(error);
      if (isRetryableCapacityError(runtime, error, message)) {
        capRetryCount += 1;
        state.lastCapRetryAt = new Date().toISOString();
        state.lastCapRetryMessage = message;
        await writeState(runtime, state);

        if (
          runtime.maxCapRetries > 0 &&
          capRetryCount >= runtime.maxCapRetries
        ) {
          throw new Error(
            `ECS cap remained full after ${capRetryCount} retries. State saved to ${runtime.stateFile}.`,
          );
        }

        console.log(
          `ECS scorer cap is full. Waiting ${runtime.retryDelayMs} ms before retry ${capRetryCount + 1}.`,
        );
        await delay(runtime.retryDelayMs);
        continue;
      }

      state.pending.shift();
      state.failed.push({
        ...candidate,
        error: message,
        failedAt: new Date().toISOString(),
      });
      await writeState(runtime, state);
      console.error(
        `Non-cap dispatch failure for review ${candidate.reviewId}: ${message}`,
      );
    }
  }

  return {
    acceptedDispatches,
    pending: state.pending.length,
  };
}

/**
 * Checks whether the current process has accepted enough dispatches for one run.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {number} acceptedDispatches Accepted dispatch count in this process.
 * @returns {boolean} True when dispatching should pause.
 */
function hasReachedDispatchLimit(runtime, acceptedDispatches) {
  return runtime.maxDispatches > 0 && acceptedDispatches >= runtime.maxDispatches;
}

/**
 * Loads a previous state file for dispatch resume.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Mutable state.
 */
async function loadResumeState(runtime) {
  const raw = await readFile(runtime.resumeState, 'utf8');
  const state = JSON.parse(raw);
  if (!isRecord(state)) {
    throw new Error(`Resume state ${runtime.resumeState} is not a JSON object.`);
  }

  if (state.challengeId !== runtime.challengeId) {
    throw new Error(
      `Resume state challengeId ${state.challengeId} does not match ${runtime.challengeId}.`,
    );
  }

  state.pending = Array.isArray(state.pending) ? state.pending : [];
  state.launched = Array.isArray(state.launched) ? state.launched : [];
  state.failed = Array.isArray(state.failed) ? state.failed : [];
  state.resumedAt = new Date().toISOString();
  await writeState(runtime, state);
  return state;
}

/**
 * Checks whether an API failure should be treated as capacity back-pressure.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {unknown} error Error value from dispatch.
 * @param {string} message Extracted message.
 * @returns {boolean} True when the dispatch should retry later.
 */
function isRetryableCapacityError(runtime, error, message) {
  if (isEcsCapMessage(message)) {
    return true;
  }

  if (!runtime.retryInternal500 || !(error instanceof ApiError)) {
    return false;
  }

  return (
    error.status >= 500 &&
    message.includes('/internal/system-score') &&
    isGenericInternalServerError(message)
  );
}

/**
 * Checks whether an error message represents the ECS scorer cap condition.
 * @param {string | undefined} message Error message.
 * @returns {boolean} True when dispatch should be retried later.
 */
function isEcsCapMessage(message) {
  return String(message ?? '').includes('ECS scorer task concurrency limit reached');
}

/**
 * Checks for generic Nest internal server errors that can hide the cap condition.
 * @param {string | undefined} message Error message.
 * @returns {boolean} True for generic internal server errors.
 */
function isGenericInternalServerError(message) {
  const normalized = String(message ?? '').toLowerCase();
  return normalized.includes('internal server error') || normalized.includes('http 500');
}

/**
 * Extracts a readable message from errors and API response bodies.
 * @param {unknown} error Error value.
 * @returns {string} Human-readable message.
 */
function getErrorMessage(error) {
  if (error instanceof ApiError) {
    return [
      error.message,
      extractMessageFromBody(error.body),
      `HTTP ${error.status}`,
    ]
      .filter(Boolean)
      .join(' | ');
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

/**
 * Extracts nested API message fields from common response bodies.
 * @param {unknown} body API response body.
 * @returns {string | undefined} Extracted message.
 */
function extractMessageFromBody(body) {
  if (typeof body === 'string') {
    return body;
  }

  if (!isRecord(body)) {
    return undefined;
  }

  const candidates = [
    body.message,
    body.error,
    body.details,
    isRecord(body.result) ? body.result.message : undefined,
    isRecord(body.response) ? body.response.message : undefined,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      const joined = candidate.map(String).join('; ');
      if (joined) {
        return joined;
      }
    }

    const value = asNonEmptyString(candidate);
    if (value) {
      return value;
    }
  }

  return JSON.stringify(body);
}

/**
 * Waits for a duration.
 * @param {number} delayMs Delay in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function delay(delayMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, delayMs);
  });
}

/**
 * Checks whether a value is a plain object record.
 * @param {unknown} value Value to inspect.
 * @returns {value is Record<string, unknown>} True when value is an object record.
 */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts any value into a record when possible.
 * @param {unknown} value Value to coerce.
 * @returns {Record<string, unknown>} Object record or empty object.
 */
function asRecord(value) {
  return isRecord(value) ? value : {};
}

/**
 * Converts a value into a non-empty string when possible.
 * @param {unknown} value Value to convert.
 * @returns {string | undefined} Trimmed string or undefined.
 */
function asNonEmptyString(value) {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

/**
 * Normalizes a status value to upper case.
 * @param {unknown} value Raw status value.
 * @returns {string | undefined} Normalized status.
 */
function normalizeStatus(value) {
  return asNonEmptyString(value)?.toUpperCase();
}

/**
 * Normalizes phase names used in metadata.
 * @param {unknown} value Raw phase value.
 * @returns {string | undefined} Normalized phase.
 */
function normalizePhase(value) {
  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized === 'final') {
    return 'system';
  }

  return normalized;
}

/**
 * Parses boolean-like values from API payloads.
 * @param {unknown} value Raw value.
 * @returns {boolean | undefined} Parsed boolean.
 */
function parseBooleanFlag(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = asNonEmptyString(value)?.toLowerCase();
  if (['1', 'true', 'yes', 'y'].includes(normalized ?? '')) {
    return true;
  }

  if (['0', 'false', 'no', 'n'].includes(normalized ?? '')) {
    return false;
  }

  return undefined;
}

/**
 * Converts numeric-like values to numbers.
 * @param {unknown} value Raw value.
 * @returns {number | undefined} Finite number or undefined.
 */
function toNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  return undefined;
}

/**
 * Counts array values, returning undefined for non-arrays.
 * @param {unknown} value Raw value.
 * @returns {number | undefined} Array length or undefined.
 */
function countArray(value) {
  return Array.isArray(value) ? value.length : undefined;
}

/**
 * Parses a positive integer.
 * @param {unknown} value Raw value.
 * @returns {number | undefined} Parsed positive integer.
 */
function parsePositiveInteger(value) {
  const parsed = Number.parseInt(asNonEmptyString(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Parses a non-negative integer.
 * @param {unknown} value Raw value.
 * @returns {number | undefined} Parsed non-negative integer.
 */
function parseNonNegativeInteger(value) {
  const parsed = Number.parseInt(asNonEmptyString(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * Writes final or paused dispatch state and prints a matching summary.
 * @param {Record<string, unknown>} runtime Script runtime configuration.
 * @param {Record<string, unknown>} state Mutable persisted state.
 * @returns {Promise<void>} Resolves after writing the state file.
 */
async function finalizeDispatchState(runtime, state) {
  if (state.pending.length > 0) {
    state.pausedAt = state.pausedAt ?? new Date().toISOString();
    state.pauseReason =
      state.pauseReason ??
      `Pending reruns remain after dispatch run. Pending=${state.pending.length}.`;
    await writeState(runtime, state);
    console.log(
      `Failed SYSTEM rerun dispatch paused. Accepted launches=${state.launched.length}; pending=${state.pending.length}; failed=${state.failed.length}.`,
    );
    console.log(
      `Resume later: node scripts/rerun-failed-system-reviews.mjs --challenge-id ${runtime.challengeId} --resume-state ${runtime.stateFile} --dispatch`,
    );
    return;
  }

  state.completedAt = new Date().toISOString();
  delete state.pausedAt;
  delete state.pauseReason;
  await writeState(runtime, state);
  console.log(
    `Failed SYSTEM rerun dispatch complete. Accepted launches=${state.launched.length}; failed=${state.failed.length}.`,
  );
}

/**
 * Runs the candidate selection and optional dispatch workflow.
 * @returns {Promise<void>} Resolves after selection or dispatch completes.
 */
async function main() {
  const runtime = buildRuntimeConfig(parseArgs(process.argv.slice(2)));
  console.log(`Marathon Match API: ${runtime.mmApiBase}`);
  console.log(`Review API: ${runtime.reviewApiBase}`);
  console.log(`Dispatch enabled: ${runtime.dispatch ? 'yes' : 'no'}`);
  console.log(
    `Max accepted dispatches per run: ${
      runtime.maxDispatches === 0 ? 'unlimited' : runtime.maxDispatches
    }`,
  );

  if (runtime.resumeState) {
    const state = await loadResumeState(runtime);
    console.log(
      `Loaded ${runtime.resumeState}; pending=${state.pending.length}; launched=${state.launched.length}; failed=${state.failed.length}.`,
    );
    if (!runtime.dispatch) {
      console.log('Resume loaded without --dispatch; no reruns launched.');
      return;
    }

    await drainPending(runtime, state);
    await finalizeDispatchState(runtime, state);
    return;
  }

  const config = await fetchMarathonMatchConfig(runtime);
  const scorecardIds = await resolveScorecardIds(runtime, config);
  console.log(
    `SYSTEM scorecard IDs considered: ${Array.from(scorecardIds).join(', ') || '<none>'}`,
  );

  const reviews = await fetchChallengeReviews(runtime);
  const systemCandidates = getSystemReviewCandidates(reviews, scorecardIds);
  console.log(
    `Fetched ${reviews.length} reviews; ${systemCandidates.length} match SYSTEM review criteria.`,
  );

  const { selected, skipped } = await selectFailedCandidates(
    runtime,
    systemCandidates,
  );
  const state = {
    challengeId: runtime.challengeId,
    startedAt: new Date().toISOString(),
    scorecardIds: Array.from(scorecardIds),
    selection: {
      totalReviewsFetched: reviews.length,
      systemCandidates: systemCandidates.length,
      selected: selected.length,
      skipped: skipped.length,
    },
    dispatchLimitPerRun: runtime.maxDispatches,
    pending: selected,
    launched: [],
    failed: [],
    skipped,
  };

  await writeState(runtime, state);
  await writeCommandsFile(runtime, selected);
  console.log(
    `Selected ${selected.length} failed SYSTEM review(s). State file: ${runtime.stateFile}`,
  );
  console.log(`Generated rerun shell script: ${runtime.commandsFile}`);

  if (!runtime.dispatch) {
    console.log('No reruns launched. Pass --dispatch to launch via this script.');
    return;
  }

  await drainPending(runtime, state);
  await finalizeDispatchState(runtime, state);
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
