#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';

const DEFAULT_API_BASE = 'https://api.topcoder.com/v6';
const DEFAULT_RETRY_DELAY_MS = 5 * 60 * 1000;

/**
 * Error type used for failed API calls so callers can inspect status and body.
 * The script throws this from request helpers and formats the details before exit.
 */
class ApiError extends Error {
  /**
   * Creates an API error that keeps the HTTP response context.
   * @param {string} message Human-readable error message.
   * @param {number} status HTTP status code.
   * @param {unknown} body Parsed response body, or raw text when parsing fails.
   */
  constructor(message, status, body) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/**
 * Prints command usage and exits.
 * @returns {never} Always exits the process.
 */
function printUsageAndExit() {
  console.log(`Usage:
  node scripts/rerun-system-reviews-with-cap.mjs --challenge-id <id> [options]

Required:
  --challenge-id <id>           Marathon Match challenge ID. Can also use CHALLENGE_ID.
  --token <jwt>                 Admin/M2M bearer token. Can also use TOKEN or AUTH_TOKEN.

API options:
  --api-base <url>              Shared v6 API base. Default: ${DEFAULT_API_BASE}
  --mm-api-base <url>           Marathon Match API base. Default: <api-base>/marathon-match

Dispatch options:
  --retry-delay-ms <ms>         Delay before retrying when the ECS cap is full. Default: ${DEFAULT_RETRY_DELAY_MS}
  --max-cap-retries <n>         Stop after n cap retries. Default: unlimited.
  --expect-count <n>            Fail if /rerun/system selects a different review count.
  --retry-internal-500 <bool>   Treat generic /internal/system-score HTTP 500s as retryable.
                                Default: true, because Nest hides the ECS-cap message on that endpoint.

Output options:
  --state-file <path>           State JSON file. Default: system-rerun-<challengeId>-<timestamp>.json
  --resume-state <path>         Resume a previous state file instead of calling /rerun/system again.
  --dry-run                     Run the initial /rerun/system call, save state, and stop before backlog draining.
`);
  process.exit(0);
}

/**
 * Parses CLI arguments into a key/value object.
 * @param {string[]} argv Raw process arguments after the script name.
 * @returns {Record<string, string | boolean>} Parsed arguments.
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
 * Converts a kebab-case CLI option into camelCase.
 * @param {string} value Raw option name.
 * @returns {string} Camel-case option name.
 */
function toCamelCase(value) {
  return value.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
}

/**
 * Reads a string option from CLI args or environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {string | undefined} defaultValue Default value.
 * @returns {string | undefined} Resolved string value.
 */
function getStringOption(args, key, envNames = [], defaultValue = undefined) {
  const argValue = args[key];
  if (typeof argValue === 'string' && argValue.trim().length > 0) {
    return argValue.trim();
  }

  for (const envName of envNames) {
    const envValue = process.env[envName];
    if (typeof envValue === 'string' && envValue.trim().length > 0) {
      return envValue.trim();
    }
  }

  return defaultValue;
}

/**
 * Reads an integer option from CLI args or environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {number} defaultValue Default value.
 * @returns {number} Resolved integer.
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
 * Reads a boolean option from CLI args or environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @param {boolean} defaultValue Default value.
 * @returns {boolean} Resolved boolean.
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
 * Builds validated runtime configuration from CLI args and environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @returns {Record<string, unknown>} Runtime configuration used by the script.
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
  const token = getStringOption(args, 'token', ['TOKEN', 'AUTH_TOKEN']);
  const retryDelayMs = getIntegerOption(
    args,
    'retryDelayMs',
    ['SYSTEM_RERUN_RETRY_DELAY_MS'],
    DEFAULT_RETRY_DELAY_MS,
  );
  const maxCapRetries = getIntegerOption(
    args,
    'maxCapRetries',
    ['SYSTEM_RERUN_MAX_CAP_RETRIES'],
    0,
  );
  const expectCountRaw = getStringOption(args, 'expectCount', [
    'SYSTEM_RERUN_EXPECT_COUNT',
  ]);
  const expectCount =
    expectCountRaw === undefined
      ? undefined
      : Number.parseInt(expectCountRaw, 10);
  const dryRun = getBooleanOption(args, 'dryRun', ['SYSTEM_RERUN_DRY_RUN'], false);
  const retryInternal500 = getBooleanOption(
    args,
    'retryInternal500',
    ['SYSTEM_RERUN_RETRY_INTERNAL_500'],
    true,
  );
  const resumeState = getStringOption(args, 'resumeState', [
    'SYSTEM_RERUN_RESUME_STATE',
  ]);

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

  if (
    expectCount !== undefined &&
    (!Number.isInteger(expectCount) || expectCount < 0)
  ) {
    throw new Error('--expect-count must be 0 or a positive integer.');
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stateFile = getStringOption(
    args,
    'stateFile',
    ['SYSTEM_RERUN_STATE_FILE'],
    resumeState ?? `system-rerun-${challengeId}-${timestamp}.json`,
  );

  return {
    apiBase,
    challengeId,
    dryRun,
    expectCount,
    maxCapRetries,
    mmApiBase,
    retryDelayMs,
    retryInternal500,
    resumeState,
    stateFile,
    token,
  };
}

/**
 * Removes trailing slashes from a URL string.
 * @param {string | undefined} value Input URL.
 * @returns {string} URL without trailing slashes.
 */
function stripTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

/**
 * Joins URL path segments without duplicating slashes.
 * @param {...string} parts URL parts.
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
 * Parses an HTTP response as JSON or text.
 * @param {Response} response Fetch response.
 * @returns {Promise<unknown>} Parsed response.
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
 * Performs an authenticated JSON API request.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} url Request URL.
 * @param {Record<string, unknown>} options Fetch options.
 * @returns {Promise<unknown>} Parsed response body.
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
 * Calls the batch SYSTEM rerun endpoint once to select all existing system reviews.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Batch dispatch response.
 */
async function startSystemRerun(runtime) {
  const url = joinUrl(
    runtime.mmApiBase,
    'challenge',
    runtime.challengeId,
    'rerun/system',
  );
  return await requestJson(runtime, url, { method: 'POST', body: {} });
}

/**
 * Dispatches one known review/submission pair through the single SYSTEM endpoint.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {{reviewId: string, submissionId: string}} candidate Backlog candidate.
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
 * Converts the batch rerun response into launched, cap-backlog, and failed lists.
 * @param {Record<string, unknown>} response Batch rerun response.
 * @returns {{results: Array<Record<string, unknown>>, launched: Array<Record<string, unknown>>, backlog: Array<{reviewId: string, submissionId: string, error: string}>, failed: Array<Record<string, unknown>>}} Normalized result groups.
 */
function normalizeInitialResults(response) {
  const results = Array.isArray(response?.results)
    ? response.results.filter(isRecord)
    : [];
  const launched = [];
  const backlog = [];
  const failed = [];

  for (const result of results) {
    const reviewId = asNonEmptyString(result.reviewId);
    const submissionId = asNonEmptyString(result.submissionId);
    const error = asNonEmptyString(result.error);

    if (asNonEmptyString(result.taskId) || asNonEmptyString(result.taskArn)) {
      launched.push(result);
      continue;
    }

    if (reviewId && submissionId && error && isEcsCapMessage(error)) {
      backlog.push({ reviewId, submissionId, error });
      continue;
    }

    if (error) {
      failed.push(result);
    }
  }

  return { results, launched, backlog, failed };
}

/**
 * Drains cap-failed review dispatches by retrying until the API accepts them.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} state Mutable script state persisted after changes.
 * @returns {Promise<void>} Resolves after every retryable backlog item is accepted.
 */
async function drainBacklog(runtime, state) {
  let capRetryCount = 0;

  while (state.pending.length > 0) {
    const candidate = state.pending[0];
    console.log(
      `Dispatching backlog review ${candidate.reviewId} for submission ${candidate.submissionId}. Pending=${state.pending.length}`,
    );

    try {
      await dispatchSingleSystemReview(runtime, candidate);
      state.pending.shift();
      state.launched.push({
        ...candidate,
        launchedBy: 'internal/system-score',
        launchedAt: new Date().toISOString(),
      });
      await writeState(runtime, state);
      capRetryCount = 0;
      continue;
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
}

/**
 * Writes the current script state as formatted JSON.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} state State object to persist.
 * @returns {Promise<void>} Resolves after writing the state file.
 */
async function writeState(runtime, state) {
  await writeFile(runtime.stateFile, `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Waits for the requested number of milliseconds.
 * @param {number} delayMs Delay duration.
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
 * Extracts a readable message from errors and API response bodies.
 * @param {unknown} error Error value.
 * @returns {string} Human-readable error text.
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
 * Checks whether an API failure should be treated as capacity back-pressure.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {unknown} error Error value from the dispatch attempt.
 * @param {string} message Extracted error message.
 * @returns {boolean} True when the script should wait and retry the same item.
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
 * Extracts nested API error message strings from common response shapes.
 * @param {unknown} body API response body.
 * @returns {string | undefined} Extracted message, if present.
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
 * Checks whether an error message represents the known ECS scorer cap condition.
 * @param {string | undefined} message Error message.
 * @returns {boolean} True when dispatch should be retried later.
 */
function isEcsCapMessage(message) {
  return String(message ?? '').includes('ECS scorer task concurrency limit reached');
}

/**
 * Checks whether a message is the generic Nest 500 response that hides the
 * underlying system-score exception in production logs.
 * @param {string | undefined} message Error message.
 * @returns {boolean} True when the message is the generic internal error.
 */
function isGenericInternalServerError(message) {
  const normalized = String(message ?? '').toLowerCase();
  return (
    normalized.includes('internal server error') ||
    normalized.includes('http 500')
  );
}

/**
 * Reads and prepares a saved state file for resumed backlog dispatch.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Mutable state ready for draining.
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

  const stillFailed = [];
  let restoredCount = 0;
  for (const failure of state.failed) {
    if (isRetryableFailedStateEntry(runtime, failure)) {
      state.pending.push({
        reviewId: failure.reviewId,
        submissionId: failure.submissionId,
        error: failure.error,
        restoredFromFailedAt: new Date().toISOString(),
      });
      restoredCount += 1;
      continue;
    }

    stillFailed.push(failure);
  }

  state.failed = stillFailed;
  state.resumedAt = new Date().toISOString();
  state.restoredRetryableFailureCount =
    Number(state.restoredRetryableFailureCount ?? 0) + restoredCount;
  await writeState(runtime, state);
  console.log(
    `Loaded resume state ${runtime.resumeState}; pending=${state.pending.length}; restored retryable failures=${restoredCount}; failed=${state.failed.length}.`,
  );

  return state;
}

/**
 * Checks whether a failed state entry is safe to move back to pending on resume.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {unknown} value Failed state entry.
 * @returns {boolean} True when the entry represents a retryable capacity failure.
 */
function isRetryableFailedStateEntry(runtime, value) {
  if (!isRecord(value)) {
    return false;
  }

  if (!asNonEmptyString(value.reviewId) || !asNonEmptyString(value.submissionId)) {
    return false;
  }

  const message = asNonEmptyString(value.error) ?? '';
  return (
    isEcsCapMessage(message) ||
    (runtime.retryInternal500 &&
      message.includes('/internal/system-score') &&
      isGenericInternalServerError(message))
  );
}

/**
 * Runs the full rerun workflow.
 * @returns {Promise<void>} Resolves after all retryable dispatches are accepted.
 */
async function main() {
  const runtime = buildRuntimeConfig(parseArgs(process.argv.slice(2)));
  console.log(`Marathon Match API: ${runtime.mmApiBase}`);
  console.log(`Cap retry delay: ${runtime.retryDelayMs} ms`);

  if (runtime.resumeState) {
    console.log(`Resuming SYSTEM rerun for challenge ${runtime.challengeId}.`);
    const state = await loadResumeState(runtime);
    if (runtime.dryRun) {
      console.log('Dry run requested; stopping before backlog draining.');
      return;
    }

    await drainBacklog(runtime, state);
    state.completedAt = new Date().toISOString();
    await writeState(runtime, state);
    console.log(
      `SYSTEM rerun dispatch complete. Accepted launches=${state.launched.length}; failed=${state.failed.length}.`,
    );
    return;
  }

  console.log(`Starting SYSTEM rerun for challenge ${runtime.challengeId}.`);

  const initialResponse = await startSystemRerun(runtime);
  const normalized = normalizeInitialResults(initialResponse);
  const reviewsQueued = Number(initialResponse?.reviewsQueued ?? normalized.results.length);

  if (
    runtime.expectCount !== undefined &&
    Number(runtime.expectCount) !== reviewsQueued
  ) {
    throw new Error(
      `/rerun/system selected ${reviewsQueued} reviews, expected ${runtime.expectCount}.`,
    );
  }

  const state = {
    challengeId: runtime.challengeId,
    startedAt: new Date().toISOString(),
    reviewsQueued,
    initialResponse,
    initialCounts: {
      launched: normalized.launched.length,
      retryableBacklog: normalized.backlog.length,
      failed: normalized.failed.length,
    },
    pending: normalized.backlog,
    launched: normalized.launched,
    failed: normalized.failed,
  };

  await writeState(runtime, state);
  console.log(
    `Initial dispatch selected ${reviewsQueued}; launched=${normalized.launched.length}; retryable backlog=${normalized.backlog.length}; non-cap failures=${normalized.failed.length}.`,
  );
  console.log(`State file: ${runtime.stateFile}`);

  if (runtime.dryRun) {
    console.log('Dry run requested; stopping before backlog draining.');
    return;
  }

  await drainBacklog(runtime, state);
  state.completedAt = new Date().toISOString();
  await writeState(runtime, state);

  console.log(
    `SYSTEM rerun dispatch complete. Accepted launches=${state.launched.length}; failed=${state.failed.length}.`,
  );
}

main().catch((error) => {
  console.error(getErrorMessage(error));
  process.exit(1);
});
