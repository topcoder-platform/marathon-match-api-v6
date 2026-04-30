#!/usr/bin/env node

import { createWriteStream } from 'node:fs';
import {
  access,
  mkdir,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const DEFAULT_API_BASE = 'https://api.topcoder.com/v6';
const DEFAULT_FIXTURE_ROOT = 'scripts/fixtures';
const DEFAULT_PER_PAGE = 100;
const MANIFEST_FILE_NAME = 'marathon-match-test.json';
const TESTER_FILE_NAME = 'tester.java';
const SUBMISSIONS_DIR_NAME = 'submissions';

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
  node scripts/create-mm-fixture-from-production.mjs --source-challenge-id <id> --fixture-name <name> [options]

Required:
  --source-challenge-id <id>    Production Marathon Match challenge ID.
  --token <jwt>                 M2M bearer token. Can also use TOKEN or AUTH_TOKEN.

Output options:
  --fixture-name <name>         Folder name under scripts/fixtures. Defaults to the challenge ID.
  --fixture-dir <dir>           Exact output directory. Overrides --fixture-name.
  --fixture-root <dir>          Parent output directory. Default: ${DEFAULT_FIXTURE_ROOT}
  --overwrite                   Overwrite existing manifest/submission files.

Source API options:
  --source-api-base <url>       Production v6 API base. Default: ${DEFAULT_API_BASE}
  --source-review-api-base <url>
                                Review API base. Default: <source-api-base>
  --source-submission-type <t>  Submission type filter. Default: CONTEST_SUBMISSION
  --per-page <n>                Page size for API searches. Default: ${DEFAULT_PER_PAGE}
  --max-submissions <n>         Stop after n submissions. Default: no limit.
  --latest-only                 Keep only the latest source submission per production member.
  --skip-downloads              Write manifest only; do not download submission files.
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
      args[toCamelCase(withoutPrefix.slice(0, equalsIndex))] = withoutPrefix.slice(equalsIndex + 1);
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

  return ['1', 'true', 'yes', 'y'].includes(raw.trim().toLowerCase());
}

/**
 * Builds script configuration from CLI args and environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @returns {Record<string, unknown>} Runtime configuration.
 */
function buildRuntimeConfig(args) {
  const sourceChallengeId = getStringOption(args, 'sourceChallengeId', [
    'SOURCE_CHALLENGE_ID',
  ]);
  const token = getStringOption(args, 'token', ['TOKEN', 'AUTH_TOKEN']);
  const sourceApiBase = normalizeApiV6Base(stripTrailingSlash(
    getStringOption(args, 'sourceApiBase', [
      'SOURCE_API_BASE',
      'TOPCODER_API_BASE',
      'API_BASE',
    ], DEFAULT_API_BASE),
  ));
  const sourceReviewApiBase = normalizeApiV6Base(stripTrailingSlash(
    getStringOption(args, 'sourceReviewApiBase', ['SOURCE_REVIEW_API_BASE'], sourceApiBase),
  ));
  const fixtureName =
    getStringOption(args, 'fixtureName', ['MM_FIXTURE_NAME']) ??
    slugify(sourceChallengeId ?? 'marathon-match');
  const fixtureRoot = getStringOption(args, 'fixtureRoot', [
    'MM_FIXTURE_ROOT',
  ], DEFAULT_FIXTURE_ROOT);
  const configuredFixtureDir = getStringOption(args, 'fixtureDir', [
    'MM_FIXTURE_DIR',
  ]);
  const perPage = getIntegerOption(args, 'perPage', ['SOURCE_PER_PAGE'], DEFAULT_PER_PAGE);
  const maxSubmissions = getIntegerOption(args, 'maxSubmissions', [
    'MAX_SOURCE_SUBMISSIONS',
  ], 0);

  if (!sourceChallengeId) {
    throw new Error('--source-challenge-id or SOURCE_CHALLENGE_ID is required.');
  }
  if (!token) {
    throw new Error('--token, TOKEN, or AUTH_TOKEN is required.');
  }
  if (perPage <= 0) {
    throw new Error('--per-page must be greater than zero.');
  }
  if (maxSubmissions < 0) {
    throw new Error('--max-submissions must be zero or greater.');
  }

  const fixtureDir = configuredFixtureDir ??
    join(fixtureRoot, fixtureName);

  return {
    sourceChallengeId,
    token,
    sourceApiBase,
    sourceReviewApiBase,
    sourceSubmissionType: getStringOption(args, 'sourceSubmissionType', [
      'SOURCE_SUBMISSION_TYPE',
    ], 'CONTEST_SUBMISSION'),
    fixtureName,
    fixtureDir: isAbsolute(fixtureDir) ? fixtureDir : resolve(fixtureDir),
    perPage,
    maxSubmissions,
    latestOnly: getBooleanOption(args, 'latestOnly', ['MM_FIXTURE_LATEST_ONLY'], false),
    overwrite: getBooleanOption(args, 'overwrite', ['MM_FIXTURE_OVERWRITE'], false),
    skipDownloads: getBooleanOption(args, 'skipDownloads', ['MM_FIXTURE_SKIP_DOWNLOADS'], false),
  };
}

/**
 * Removes a trailing slash from a URL-like string.
 * @param {string} value URL-like string.
 * @returns {string} URL without trailing slashes.
 */
function stripTrailingSlash(value) {
  return value.replace(/\/+$/, '');
}

/**
 * Normalizes a Topcoder API base so service paths can be appended under /v6.
 * @param {string} value API base URL, with or without a trailing /v6.
 * @returns {string} API base ending in /v6.
 */
function normalizeApiV6Base(value) {
  const normalized = stripTrailingSlash(value);
  return normalized.endsWith('/v6') ? normalized : `${normalized}/v6`;
}

/**
 * Joins URL parts without duplicating slashes.
 * @param {...string} parts URL path parts.
 * @returns {string} Joined URL.
 */
function joinUrl(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map((part, index) =>
      index === 0 ? stripTrailingSlash(String(part)) : String(part).replace(/^\/+|\/+$/g, ''),
    )
    .join('/');
}

/**
 * Logs one timestamped progress line.
 * @param {string} message Message to print.
 * @param {Record<string, unknown> | undefined} data Optional structured data.
 * @returns {void}
 */
function logStep(message, data = undefined) {
  const suffix = data ? ` ${JSON.stringify(data)}` : '';
  console.log(`[${new Date().toISOString()}] ${message}${suffix}`);
}

/**
 * Performs an authenticated JSON API request and returns headers with the body.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} url Request URL.
 * @returns {Promise<{ body: unknown, headers: Headers }>} Parsed response and headers.
 */
async function requestJsonWithHeaders(runtime, url) {
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

  return { body, headers: response.headers };
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
 * Fetches all source submissions for the configured production challenge.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Array<Record<string, unknown>>>} Source submission records.
 */
async function fetchSourceSubmissions(runtime) {
  const submissions = [];
  let page = 1;

  while (true) {
    const query = new URLSearchParams({
      challengeId: runtime.sourceChallengeId,
      page: String(page),
      perPage: String(runtime.perPage),
    });
    if (runtime.sourceSubmissionType) {
      query.set('type', runtime.sourceSubmissionType);
    }

    const response = await requestJsonWithHeaders(
      runtime,
      `${joinUrl(runtime.sourceReviewApiBase, 'submissions')}?${query}`,
    );
    const pageSubmissions = extractResponseItems(response.body);
    submissions.push(...pageSubmissions);

    const totalPages = getTotalPages(response.headers, response.body);
    if (totalPages ? page >= totalPages : pageSubmissions.length < runtime.perPage) {
      break;
    }
    if (runtime.maxSubmissions > 0 && submissions.length >= runtime.maxSubmissions) {
      break;
    }

    page += 1;
  }

  const limited = runtime.maxSubmissions > 0
    ? submissions.slice(0, runtime.maxSubmissions)
    : submissions;
  const sorted = sortSubmissions(limited);
  return runtime.latestOnly ? latestSubmissionsBySourceMember(sorted) : sorted;
}

/**
 * Fetches review summations for a source submission.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} submissionId Source submission ID.
 * @returns {Promise<Array<Record<string, unknown>>>} Review summation rows.
 */
async function fetchReviewSummations(runtime, submissionId) {
  const summations = [];
  let page = 1;

  while (true) {
    const query = new URLSearchParams({
      submissionId,
      metadata: 'true',
      page: String(page),
      perPage: String(runtime.perPage),
    });
    const response = await requestJsonWithHeaders(
      runtime,
      `${joinUrl(runtime.sourceReviewApiBase, 'reviewSummations')}?${query}`,
    );
    const pageSummations = extractResponseItems(response.body);
    summations.push(...pageSummations);

    const totalPages = getTotalPages(response.headers, response.body);
    if (totalPages ? page >= totalPages : pageSummations.length < runtime.perPage) {
      break;
    }

    page += 1;
  }

  return summations;
}

/**
 * Downloads a source submission file through review-api-v6.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} submissionId Source submission ID.
 * @param {string} filePath Destination file path.
 * @returns {Promise<void>} Resolves once the file is written.
 */
async function downloadSubmission(runtime, submissionId, filePath) {
  if (!runtime.overwrite && await exists(filePath)) {
    logStep('Submission file already exists; keeping it', { file: filePath });
    return;
  }

  const response = await fetch(
    joinUrl(runtime.sourceReviewApiBase, 'submissions', submissionId, 'download'),
    {
      headers: {
        Authorization: `Bearer ${runtime.token}`,
        Accept: 'application/zip,application/octet-stream,*/*',
      },
    },
  );
  if (!response.ok) {
    throw new ApiError(
      `Request failed: GET /submissions/${submissionId}/download`,
      response.status,
      await parseResponse(response),
    );
  }
  if (!response.body) {
    throw new Error(`Submission ${submissionId} download response did not include a body.`);
  }

  const temporaryFilePath = `${filePath}.download`;
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporaryFilePath));
    await rename(temporaryFilePath, filePath);
  } catch (error) {
    await removeFileIfExists(temporaryFilePath);
    throw error;
  }
}

/**
 * Creates fixture directories and a tester placeholder when needed.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<void>} Resolves once directories exist.
 */
async function prepareFixtureDirectory(runtime) {
  await mkdir(join(runtime.fixtureDir, SUBMISSIONS_DIR_NAME), { recursive: true });

  const testerPath = join(runtime.fixtureDir, TESTER_FILE_NAME);
  if (!runtime.overwrite && await exists(testerPath)) {
    return;
  }

  await writeFile(
    testerPath,
    [
      '// Replace this placeholder with the Marathon Match tester source.',
      'public class Tester {',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
}

/**
 * Checks whether a filesystem path exists.
 * @param {string} path Filesystem path.
 * @returns {Promise<boolean>} True when the path exists.
 */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes a file if it exists, ignoring missing-file errors.
 * @param {string} path File path.
 * @returns {Promise<void>} Resolves after removal attempt.
 */
async function removeFileIfExists(path) {
  try {
    await unlink(path);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

/**
 * Converts API response envelopes into item arrays.
 * @param {unknown} data API response body.
 * @returns {Array<Record<string, unknown>>} Extracted records.
 */
function extractResponseItems(data) {
  if (Array.isArray(data)) {
    return data;
  }
  if (Array.isArray(data?.data)) {
    return data.data;
  }
  if (Array.isArray(data?.result?.content)) {
    return data.result.content;
  }
  if (Array.isArray(data?.result)) {
    return data.result;
  }

  return [];
}

/**
 * Reads total pages from Topcoder pagination headers or body metadata.
 * @param {Headers} headers Fetch response headers.
 * @param {unknown} body Parsed response body.
 * @returns {number | undefined} Total pages when present.
 */
function getTotalPages(headers, body) {
  const bodyRecord = body && typeof body === 'object' ? body : {};
  const raw = headers.get('x-total-pages') ?? bodyRecord.metadata?.totalPages ?? bodyRecord.meta?.totalPages;
  const parsed = Number(raw ?? '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Sorts source submissions by member and submitted date for stable fixture output.
 * @param {Array<Record<string, unknown>>} submissions Source submissions.
 * @returns {Array<Record<string, unknown>>} Sorted submissions.
 */
function sortSubmissions(submissions) {
  return submissions.slice().sort((left, right) => {
    const memberCompare = String(left.memberId ?? '').localeCompare(String(right.memberId ?? ''));
    if (memberCompare !== 0) {
      return memberCompare;
    }

    return getSubmissionSortValue(left) - getSubmissionSortValue(right);
  });
}

/**
 * Keeps only the latest source submission per production member.
 * @param {Array<Record<string, unknown>>} submissions Source submissions.
 * @returns {Array<Record<string, unknown>>} Latest submissions sorted by source order.
 */
function latestSubmissionsBySourceMember(submissions) {
  const latest = new Map();
  for (const submission of submissions) {
    const memberId = asNonEmptyString(submission.memberId) ?? 'unknown';
    const current = latest.get(memberId);
    if (!current || getSubmissionSortValue(submission) >= getSubmissionSortValue(current)) {
      latest.set(memberId, submission);
    }
  }

  return sortSubmissions(Array.from(latest.values()));
}

/**
 * Computes a stable sort value for a source submission.
 * @param {Record<string, unknown>} submission Source submission.
 * @returns {number} Sort timestamp.
 */
function getSubmissionSortValue(submission) {
  const timestamp = new Date(String(submission.submittedDate ?? submission.createdAt ?? '')).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Builds a manifest entry from one source submission and its summations.
 * @param {Record<string, unknown>} submission Source submission.
 * @param {Array<Record<string, unknown>>} summations Source review summations.
 * @param {string} filePath Manifest-relative file path.
 * @param {number} index Zero-based source submission index.
 * @returns {Record<string, unknown>} Manifest submission entry.
 */
function buildManifestSubmission(submission, summations, filePath, index) {
  const expectedScores = removeUndefinedProperties({
    provisional: getSummationScore(summations, (summation) =>
      isTruthy(summation.isProvisional) && !isTruthy(summation.isExample),
    ),
    system: getSummationScore(summations, (summation) =>
      isTruthy(summation.isFinal),
    ),
  });
  const source = removeUndefinedProperties({
    submissionId: asNonEmptyString(submission.id),
    memberId: asNonEmptyString(submission.memberId),
    memberHandle: getSourceMemberHandle(submission, summations),
    submittedDate: asNonEmptyString(submission.submittedDate),
    createdAt: asNonEmptyString(submission.createdAt),
    legacySubmissionId: asNonEmptyString(submission.legacySubmissionId),
    legacyUploadId: asNonEmptyString(submission.legacyUploadId),
    url: asNonEmptyString(submission.url),
  });

  return removeUndefinedProperties({
    memberId: `<test_member_id_${String(index + 1).padStart(3, '0')}>`,
    memberHandle: `<test_member_handle_${String(index + 1).padStart(3, '0')}>`,
    file: filePath,
    expectedScores:
      Object.keys(expectedScores).length > 0 ? expectedScores : undefined,
    source,
  });
}

/**
 * Gets a score from matching summations, preferring the newest matching row.
 * @param {Array<Record<string, unknown>>} summations Review summation rows.
 * @param {(summation: Record<string, unknown>) => boolean} predicate Match predicate.
 * @returns {number | undefined} Aggregate score when found.
 */
function getSummationScore(summations, predicate) {
  const matches = summations
    .filter(predicate)
    .filter((summation) => summation.aggregateScore !== undefined && summation.aggregateScore !== null)
    .sort((left, right) => getSummationSortValue(right) - getSummationSortValue(left));
  const score = Number(matches[0]?.aggregateScore);
  return Number.isFinite(score) ? score : undefined;
}

/**
 * Computes a stable sort value for a review summation.
 * @param {Record<string, unknown>} summation Review summation row.
 * @returns {number} Sort timestamp.
 */
function getSummationSortValue(summation) {
  const timestamp = new Date(String(summation.updatedAt ?? summation.createdAt ?? '')).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

/**
 * Reads the production member handle from submission or summation fields.
 * @param {Record<string, unknown>} submission Source submission.
 * @param {Array<Record<string, unknown>>} summations Source review summations.
 * @returns {string | undefined} Production member handle.
 */
function getSourceMemberHandle(submission, summations) {
  return asNonEmptyString(
    submission.memberHandle ??
      submission.handle ??
      submission.submitterHandle ??
      summations.find((summation) => asNonEmptyString(summation.submitterHandle))?.submitterHandle,
  );
}

/**
 * Converts common boolean/string values to boolean.
 * @param {unknown} value Candidate value.
 * @returns {boolean} True when the value represents true.
 */
function isTruthy(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

/**
 * Builds the fixture manifest with placeholders for environment-specific settings.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Array<Record<string, unknown>>} submissions Manifest submission entries.
 * @returns {Record<string, unknown>} Fixture manifest.
 */
function buildFixtureManifest(runtime, submissions) {
  return {
    challenge: {
      name: `${runtime.fixtureName} Full Test Challenge`,
      typeId: '<challenge_type_id>',
      trackId: '<challenge_track_id>',
      timelineTemplateId: '<timeline_template_id>',
      projectId: '<project_id>',
      phaseDurations: {
        registration: 3600,
        submission: 3600,
      },
      phaseIds: {
        registration: '<registration_phase_id>',
        submission: '<submission_phase_id>',
      },
      source: {
        challengeId: runtime.sourceChallengeId,
        apiBase: runtime.sourceApiBase,
      },
    },
    tester: {
      name: '<tester_name>',
      version: '<tester_version>',
      className: '<tester_class_name>',
    },
    config: {
      name: `${runtime.fixtureName} Full Test Config`,
      reviewScorecardId: '<review_scorecard_id>',
      taskDefinitionName: '<task_definition_name>',
      taskDefinitionVersion: '<task_definition_version>',
      relativeScoringEnabled: true,
      scoreDirection: 'MAXIMIZE',
      example: {
        startSeed: '<example_start_seed>',
        numberOfTests: '<example_number_of_tests>',
      },
      provisional: {
        startSeed: '<provisional_start_seed>',
        numberOfTests: '<provisional_number_of_tests>',
      },
      system: {
        startSeed: '<system_start_seed>',
        numberOfTests: '<system_number_of_tests>',
      },
    },
    submissions,
  };
}

/**
 * Creates a deterministic relative submission path for the fixture manifest.
 * @param {Record<string, unknown>} submission Source submission.
 * @param {number} index Zero-based source submission index.
 * @param {Set<string>} usedFileNames File names already allocated.
 * @returns {string} Manifest-relative file path.
 */
function buildRelativeSubmissionPath(submission, index, usedFileNames) {
  const handle = slugify(asNonEmptyString(submission.memberHandle ?? submission.handle) ?? 'member');
  const submissionId = slugify(asNonEmptyString(submission.id) ?? `submission-${index + 1}`);
  const baseName = `${String(index + 1).padStart(3, '0')}-${handle}-${submissionId.slice(0, 12)}`;
  let fileName = `${baseName}.zip`;
  let suffix = 1;
  while (usedFileNames.has(fileName)) {
    fileName = `${baseName}-${suffix}.zip`;
    suffix += 1;
  }

  usedFileNames.add(fileName);
  return join(SUBMISSIONS_DIR_NAME, fileName);
}

/**
 * Converts a value to a non-empty string when possible.
 * @param {unknown} value Candidate value.
 * @returns {string | undefined} Non-empty string.
 */
function asNonEmptyString(value) {
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }

  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }

  return undefined;
}

/**
 * Removes undefined-valued properties from a shallow record.
 * @param {Record<string, unknown>} record Source record.
 * @returns {Record<string, unknown>} Record without undefined values.
 */
function removeUndefinedProperties(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

/**
 * Converts text into a filesystem-safe slug.
 * @param {string} value Source value.
 * @returns {string} Filesystem-safe slug.
 */
function slugify(value) {
  return String(value)
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'marathon-match';
}

/**
 * Runs the production fixture export flow.
 * @returns {Promise<void>} Resolves when the fixture is written.
 */
async function main() {
  const runtime = buildRuntimeConfig(parseArgs(process.argv.slice(2)));
  await prepareFixtureDirectory(runtime);
  const manifestPath = join(runtime.fixtureDir, MANIFEST_FILE_NAME);
  if (!runtime.overwrite && await exists(manifestPath)) {
    throw new Error(`${manifestPath} already exists. Re-run with --overwrite to replace it.`);
  }

  logStep('Fetching source submissions', {
    challengeId: runtime.sourceChallengeId,
    reviewApiBase: runtime.sourceReviewApiBase,
  });
  const sourceSubmissions = await fetchSourceSubmissions(runtime);
  logStep('Fetched source submissions', { count: sourceSubmissions.length });
  if (sourceSubmissions.length === 0) {
    throw new Error(
      `No source submissions found for challenge ${runtime.sourceChallengeId}. Check the challenge ID, token permissions, and source API base.`,
    );
  }

  const manifestSubmissions = [];
  let skippedDownloads = 0;
  const usedFileNames = new Set();
  for (const [index, submission] of sourceSubmissions.entries()) {
    const submissionId = asNonEmptyString(submission.id);
    if (!submissionId) {
      throw new Error(`Source submission at index ${index} is missing id.`);
    }

    const relativePath = buildRelativeSubmissionPath(submission, index, usedFileNames);
    const outputPath = join(runtime.fixtureDir, relativePath);
    const summations = await fetchReviewSummations(runtime, submissionId);
    if (!runtime.skipDownloads) {
      logStep('Downloading source submission', {
        submissionId,
        file: relativePath,
      });
      try {
        await downloadSubmission(runtime, submissionId, outputPath);
      } catch (error) {
        skippedDownloads += 1;
        logStep('Skipping source submission because download failed', {
          submissionId,
          file: relativePath,
          error: formatErrorForLog(error),
        });
        continue;
      }
    }

    manifestSubmissions.push(
      buildManifestSubmission(submission, summations, relativePath, manifestSubmissions.length),
    );
  }
  if (manifestSubmissions.length === 0) {
    throw new Error(
      'No fixture submissions were written. All source submission downloads may have failed.',
    );
  }

  await writeFile(
    manifestPath,
    `${JSON.stringify(buildFixtureManifest(runtime, manifestSubmissions), null, 2)}\n`,
    'utf8',
  );
  logStep('Fixture export completed', {
    fixtureDir: runtime.fixtureDir,
    manifest: manifestPath,
    submissions: manifestSubmissions.length,
    skippedDownloads,
  });
}

/**
 * Formats an error for concise structured logging.
 * @param {unknown} error Error thrown while processing one submission.
 * @returns {Record<string, unknown> | string} Log-safe error details.
 */
function formatErrorForLog(error) {
  if (error instanceof ApiError) {
    return {
      message: error.message,
      status: error.status,
      body: error.body,
    };
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

main().catch((error) => {
  if (error instanceof ApiError) {
    console.error(error.message);
    console.error(`HTTP ${error.status}: ${JSON.stringify(error.body, null, 2)}`);
  } else {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
  }
  process.exit(1);
});
