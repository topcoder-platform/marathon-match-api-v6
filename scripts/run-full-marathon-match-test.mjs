#!/usr/bin/env node

import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { createReadStream } from 'node:fs';
import {
  access,
  readFile,
  readdir,
  stat,
} from 'node:fs/promises';
import { basename, extname, isAbsolute, join, resolve } from 'node:path';

const DEFAULT_API_BASE = 'https://api.topcoder-dev.com/v6';
const DEFAULT_POLL_INTERVAL_MS = 10_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SCORE_TOLERANCE = 0.000001;
const DEFAULT_SUBMISSION_TYPE = 'CONTEST_SUBMISSION';
const DEFAULT_PHASE_DURATION_SECONDS = 60 * 60;
const TESTER_FILE_NAME = 'tester.java';
const MANIFEST_FILE_NAMES = [
  'marathon-match-test.json',
  'full-marathon-match-test.json',
  'submissions.json',
];

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
  node scripts/run-full-marathon-match-test.mjs --fixture-dir <dir> [challenge creation options] [options]

Required:
  --fixture-dir <dir>           Directory containing tester.java and submissions manifest/files.
  --token <jwt>                 Admin/M2M bearer token. Can also use TOKEN.
  --challenge-type-id <id>      Required to create a challenge unless manifest challenge.typeId is set.
  --challenge-track-id <id>     Required to create a challenge unless manifest challenge.trackId is set.

Challenge creation:
  --challenge-id <id>           Reuse an existing challenge instead of creating one.
  --challenge-name <name>       Challenge name. Defaults to generated timestamp name.
  --timeline-template-id <id>   Optional if challenge-api has a default template for type/track.
  --project-id <id>             Required when the selected timeline template requires a project.
  --registration-duration-seconds <n>
                                Registration duration for new challenges. Default: ${DEFAULT_PHASE_DURATION_SECONDS}
  --submission-duration-seconds <n>
                                Submission duration for new challenges. Default: ${DEFAULT_PHASE_DURATION_SECONDS}

Common options:
  --api-base <url>              Shared v6 API base. Default: ${DEFAULT_API_BASE}
  --mm-api-base <url>           Marathon Match API base. Default: <api-base>/marathon-match
  --tester-class-name <name>    Java tester class name. Defaults to manifest or inferred class.
  --review-scorecard-id <id>    Defaults to /marathon-match/challenge/defaults.
  --task-definition-name <name> Defaults to /marathon-match/challenge/defaults.
  --task-definition-version <v> Defaults to /marathon-match/challenge/defaults.
  --submitter-role-id <id>      Defaults to SUBMITTER_ROLE_ID or resource-role lookup.
  --submission-upload-bucket <bucket>
                                Upload local submission files to S3 before POST /submissions.
  --submission-upload-prefix <prefix>
                                S3 key prefix for uploaded submissions.
  --manual-submission-upload    Use review-api /submissions/manual-upload for local fixture files.
                                Requires review-api MANUAL_UPLOAD_ALLOW_OPEN_SUBMISSION_PHASE=true while Submission is open.
  --min-artifacts <count>       Minimum artifacts expected per submission after scoring. Default: 1
  --wait-timeout-ms <ms>        Poll timeout for async scoring. Default: ${DEFAULT_WAIT_TIMEOUT_MS}
  --poll-interval-ms <ms>       Poll interval. Default: ${DEFAULT_POLL_INTERVAL_MS}

Skip switches:
  --skip-challenge-launch       Do not activate/open Registration.
  --skip-phase-advance          Do not open/close Registration, Submission, or Review.
  --skip-registration           Do not create submitter resources.
  --skip-config                 Do not create/update Marathon Match config.
  --skip-final-close            Do not wait for autopilot to close Review and complete the challenge.
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
      const key = toCamelCase(withoutPrefix.slice(0, equalsIndex));
      args[key] = withoutPrefix.slice(equalsIndex + 1);
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
  if (!Number.isFinite(parsed)) {
    throw new Error(`Option ${key} must be an integer.`);
  }

  return parsed;
}

/**
 * Reads an optional integer option from CLI args or environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @param {string} key CLI key.
 * @param {string[]} envNames Environment variable fallbacks.
 * @returns {number | undefined} Resolved integer when configured.
 */
function getOptionalIntegerOption(args, key, envNames) {
  const raw = getStringOption(args, key, envNames);
  if (raw === undefined) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Option ${key} must be an integer.`);
  }

  return parsed;
}

/**
 * Validates an integer option is not negative.
 * @param {number} value Candidate integer.
 * @param {string} key Option name for error messages.
 * @returns {number} The original value.
 */
function assertNonNegativeInteger(value, key) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`Option ${key} must be a non-negative integer.`);
  }

  return value;
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
 * Builds the runtime configuration from CLI args and environment variables.
 * @param {Record<string, string | boolean>} args Parsed CLI args.
 * @returns {Record<string, unknown>} Runtime configuration.
 */
function buildRuntimeConfig(args) {
  const fixtureDir = getStringOption(args, 'fixtureDir', [
    'MM_TEST_FIXTURE_DIR',
  ]);
  const challengeId = getStringOption(args, 'challengeId', ['CHALLENGE_ID']);
  const registrationDurationSeconds = getOptionalIntegerOption(args, 'registrationDurationSeconds', [
    'REGISTRATION_DURATION_SECONDS',
  ]);
  const submissionDurationSeconds = getOptionalIntegerOption(args, 'submissionDurationSeconds', [
    'SUBMISSION_DURATION_SECONDS',
  ]);
  const apiBase = normalizeApiV6Base(stripTrailingSlash(
    getStringOption(args, 'apiBase', ['TOPCODER_API_BASE', 'API_BASE'], DEFAULT_API_BASE),
  ));
  const mmApiBase = stripTrailingSlash(
    getStringOption(args, 'mmApiBase', ['MM_API_BASE'], joinUrl(apiBase, 'marathon-match')),
  );

  if (!fixtureDir) {
    throw new Error('--fixture-dir or MM_TEST_FIXTURE_DIR is required.');
  }

  return {
    fixtureDir: isAbsolute(fixtureDir) ? fixtureDir : resolve(fixtureDir),
    challengeId,
    challengeName: getStringOption(args, 'challengeName', ['CHALLENGE_NAME']),
    challengeTypeId: getStringOption(args, 'challengeTypeId', [
      'CHALLENGE_TYPE_ID',
    ]),
    challengeTrackId: getStringOption(args, 'challengeTrackId', [
      'CHALLENGE_TRACK_ID',
    ]),
    challengeDescription: getStringOption(args, 'challengeDescription', [
      'CHALLENGE_DESCRIPTION',
    ]),
    challengePrivateDescription: getStringOption(args, 'challengePrivateDescription', [
      'CHALLENGE_PRIVATE_DESCRIPTION',
    ]),
    timelineTemplateId: getStringOption(args, 'timelineTemplateId', [
      'TIMELINE_TEMPLATE_ID',
    ]),
    projectId: getStringOption(args, 'projectId', ['PROJECT_ID']),
    registrationPhaseId: getStringOption(args, 'registrationPhaseId', [
      'REGISTRATION_PHASE_ID',
    ]),
    submissionPhaseId: getStringOption(args, 'submissionPhaseId', [
      'SUBMISSION_PHASE_ID',
    ]),
    registrationDurationSeconds: assertNonNegativeInteger(
      registrationDurationSeconds ?? DEFAULT_PHASE_DURATION_SECONDS,
      'registrationDurationSeconds',
    ),
    registrationDurationSecondsExplicit: registrationDurationSeconds !== undefined,
    submissionDurationSeconds: assertNonNegativeInteger(
      submissionDurationSeconds ?? DEFAULT_PHASE_DURATION_SECONDS,
      'submissionDurationSeconds',
    ),
    submissionDurationSecondsExplicit: submissionDurationSeconds !== undefined,
    apiBase,
    mmApiBase,
    challengeApiBase: normalizeApiV6Base(stripTrailingSlash(
      getStringOption(args, 'challengeApiBase', ['CHALLENGE_API_BASE'], apiBase),
    )),
    resourceApiBase: normalizeApiV6Base(stripTrailingSlash(
      getStringOption(args, 'resourceApiBase', ['RESOURCE_API_BASE'], apiBase),
    )),
    reviewApiBase: normalizeApiV6Base(stripTrailingSlash(
      getStringOption(args, 'reviewApiBase', ['REVIEW_API_BASE', 'SUBMISSION_API_BASE'], apiBase),
    )),
    token: getStringOption(args, 'token', ['TOKEN', 'AUTH_TOKEN']),
    auth0Url: getStringOption(args, 'auth0Url', ['AUTH0_URL']),
    auth0ClientId: getStringOption(args, 'auth0ClientId', ['AUTH0_CLIENT_ID']),
    auth0ClientSecret: getStringOption(args, 'auth0ClientSecret', [
      'AUTH0_CLIENT_SECRET',
    ]),
    auth0Audience: getStringOption(args, 'auth0Audience', [
      'AUTH0_AUDIENCE',
      'TOKEN_AUDIENCE',
    ]),
    testerName: getStringOption(args, 'testerName', ['TESTER_NAME']),
    testerVersion: getStringOption(args, 'testerVersion', ['TESTER_VERSION']),
    testerClassName: getStringOption(args, 'testerClassName', [
      'TESTER_CLASS_NAME',
    ]),
    reviewScorecardId: getStringOption(args, 'reviewScorecardId', [
      'REVIEW_SCORECARD_ID',
    ]),
    taskDefinitionName: getStringOption(args, 'taskDefinitionName', [
      'TASK_DEFINITION_NAME',
      'DEFAULT_TASK_DEFINITION_NAME',
    ]),
    taskDefinitionVersion: getStringOption(args, 'taskDefinitionVersion', [
      'TASK_DEFINITION_VERSION',
      'DEFAULT_TASK_DEFINITION_VERSION',
    ]),
    submitterRoleId: getStringOption(args, 'submitterRoleId', [
      'SUBMITTER_ROLE_ID',
      'RESOURCE_SUBMITTER_ROLE_ID',
    ]),
    submissionUploadBucket: getStringOption(args, 'submissionUploadBucket', [
      'SUBMISSION_UPLOAD_BUCKET',
    ]),
    submissionUploadPrefix: getStringOption(args, 'submissionUploadPrefix', [
      'SUBMISSION_UPLOAD_PREFIX',
    ], 'marathon-match-full-test'),
    submissionUploadBaseUrl: getStringOption(args, 'submissionUploadBaseUrl', [
      'SUBMISSION_UPLOAD_BASE_URL',
    ]),
    manualSubmissionUpload: getBooleanOption(args, 'manualSubmissionUpload', [
      'MANUAL_SUBMISSION_UPLOAD',
    ], false),
    submissionType: getStringOption(args, 'submissionType', [
      'SUBMISSION_TYPE',
    ], DEFAULT_SUBMISSION_TYPE),
    testTimeout: getIntegerOption(args, 'testTimeout', ['TEST_TIMEOUT_MS'], 90_000),
    compileTimeout: getIntegerOption(
      args,
      'compileTimeout',
      ['COMPILE_TIMEOUT_MS'],
      120_000,
    ),
    exampleStartSeed: getIntegerOption(args, 'exampleStartSeed', [], 1),
    exampleNumberOfTests: getIntegerOption(args, 'exampleNumberOfTests', [], 10),
    provisionalStartSeed: getIntegerOption(
      args,
      'provisionalStartSeed',
      [],
      753_376_358,
    ),
    provisionalNumberOfTests: getIntegerOption(
      args,
      'provisionalNumberOfTests',
      [],
      20,
    ),
    systemStartSeed: getIntegerOption(args, 'systemStartSeed', [], 1_651_246_628),
    systemNumberOfTests: getIntegerOption(args, 'systemNumberOfTests', [], 50),
    minArtifacts: getIntegerOption(args, 'minArtifacts', ['MIN_ARTIFACTS'], 1),
    waitTimeoutMs: getIntegerOption(
      args,
      'waitTimeoutMs',
      ['WAIT_TIMEOUT_MS'],
      DEFAULT_WAIT_TIMEOUT_MS,
    ),
    pollIntervalMs: getIntegerOption(
      args,
      'pollIntervalMs',
      ['POLL_INTERVAL_MS'],
      DEFAULT_POLL_INTERVAL_MS,
    ),
    scoreTolerance: Number(
      getStringOption(args, 'scoreTolerance', ['SCORE_TOLERANCE'], String(DEFAULT_SCORE_TOLERANCE)),
    ),
    requireTestScores: getBooleanOption(args, 'requireTestScores', [
      'REQUIRE_TEST_SCORES',
    ], false),
    skipChallengeLaunch: getBooleanOption(args, 'skipChallengeLaunch', [], false),
    skipPhaseAdvance: getBooleanOption(args, 'skipPhaseAdvance', [], false),
    skipRegistration: getBooleanOption(args, 'skipRegistration', [], false),
    skipConfig: getBooleanOption(args, 'skipConfig', [], false),
    skipFinalClose: getBooleanOption(args, 'skipFinalClose', [], false),
    reuseTester: getBooleanOption(args, 'reuseTester', [], false),
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
 * Loads a JSON manifest when present in the fixture directory.
 * @param {string} fixtureDir Fixture directory.
 * @returns {Promise<Record<string, unknown> | unknown[] | null>} Parsed manifest.
 */
async function loadManifest(fixtureDir) {
  for (const fileName of MANIFEST_FILE_NAMES) {
    const path = join(fixtureDir, fileName);
    if (await exists(path)) {
      const raw = await readFile(path, 'utf8');
      return JSON.parse(raw);
    }
  }

  return null;
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
 * Loads tester source and submission fixture entries.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Fixture data.
 */
async function loadFixture(runtime) {
  const testerPath = join(runtime.fixtureDir, TESTER_FILE_NAME);
  if (!(await exists(testerPath))) {
    throw new Error(`Expected tester source at ${testerPath}.`);
  }

  const sourceCode = await readFile(testerPath, 'utf8');
  const manifest = await loadManifest(runtime.fixtureDir);
  const manifestObject = Array.isArray(manifest) ? { submissions: manifest } : manifest ?? {};
  const submissions = await resolveSubmissionFixtures(runtime.fixtureDir, manifestObject);

  if (submissions.length === 0) {
    throw new Error(
      `No submissions found. Add a manifest with a submissions array or files named "<memberId>-<handle>.<ext>" under ${runtime.fixtureDir}.`,
    );
  }

  return {
    manifest: manifestObject,
    tester: {
      sourceCode,
      className:
        runtime.testerClassName ??
        getNestedString(manifestObject, ['tester', 'className']) ??
        inferJavaClassName(sourceCode),
      name:
        runtime.testerName ??
        getNestedString(manifestObject, ['tester', 'name']) ??
        `Full Marathon Match Test ${new Date().toISOString()}`,
      version:
        runtime.testerVersion ??
        getNestedString(manifestObject, ['tester', 'version']) ??
        buildTimestampVersion(),
    },
    submissions,
  };
}

/**
 * Resolves submission fixtures from a manifest or from filename conventions.
 * @param {string} fixtureDir Fixture directory.
 * @param {Record<string, unknown>} manifest Parsed manifest.
 * @returns {Promise<Array<Record<string, unknown>>>} Submission entries.
 */
async function resolveSubmissionFixtures(fixtureDir, manifest) {
  const manifestSubmissions = Array.isArray(manifest.submissions)
    ? manifest.submissions
    : [];

  if (manifestSubmissions.length > 0) {
    return manifestSubmissions.map((entry, index) =>
      normalizeManifestSubmissionEntry(fixtureDir, entry, index),
    );
  }

  const entries = await readdir(fixtureDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((fileName) => fileName !== TESTER_FILE_NAME)
    .filter((fileName) => !MANIFEST_FILE_NAMES.includes(fileName))
    .filter((fileName) => !fileName.endsWith('.md'));

  return files.map((fileName, index) => {
    const parsed = parseSubmissionFileName(fileName);
    if (!parsed) {
      throw new Error(
        `Submission file ${fileName} does not match "<memberId>-<handle>.<ext>". Add a manifest to map users explicitly.`,
      );
    }

    return {
      memberId: parsed.memberId,
      memberHandle: parsed.memberHandle,
      file: join(fixtureDir, fileName),
      fixtureIndex: index,
    };
  });
}

/**
 * Normalizes one manifest submission entry.
 * @param {string} fixtureDir Fixture directory.
 * @param {unknown} entry Raw manifest entry.
 * @param {number} index Entry index.
 * @returns {Record<string, unknown>} Normalized submission entry.
 */
function normalizeManifestSubmissionEntry(fixtureDir, entry, index) {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`Manifest submissions[${index}] must be an object.`);
  }

  const record = entry;
  const memberId = asNonEmptyString(record.memberId);
  if (!memberId) {
    throw new Error(`Manifest submissions[${index}] is missing memberId.`);
  }

  const file = asNonEmptyString(record.file ?? record.path);
  const url = asNonEmptyString(record.url);
  if (!file && !url) {
    throw new Error(
      `Manifest submissions[${index}] must include either file/path or url.`,
    );
  }

  return {
    ...record,
    memberId,
    memberHandle: asNonEmptyString(record.memberHandle ?? record.handle),
    file: file ? (isAbsolute(file) ? file : join(fixtureDir, file)) : undefined,
    url,
    fixtureIndex: index,
  };
}

/**
 * Parses a filename convention of <memberId>-<handle>.<ext>.
 * @param {string} fileName File name.
 * @returns {{ memberId: string, memberHandle: string } | null} Parsed metadata.
 */
function parseSubmissionFileName(fileName) {
  const match = fileName.match(/^(\d+)[_-]([^./][^.]+)\.[^.]+$/);
  if (!match) {
    return null;
  }

  return {
    memberId: match[1],
    memberHandle: match[2],
  };
}

/**
 * Reads a nested string property from an object.
 * @param {Record<string, unknown>} source Object to read from.
 * @param {string[]} path Nested path.
 * @returns {string | undefined} String value when present.
 */
function getNestedString(source, path) {
  let current = source;
  for (const segment of path) {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    current = current[segment];
  }

  return asNonEmptyString(current);
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
 * Infers the public Java class name from tester source.
 * @param {string} sourceCode Java source code.
 * @returns {string} Java class name.
 */
function inferJavaClassName(sourceCode) {
  const publicClassMatch = sourceCode.match(/\bpublic\s+class\s+([A-Za-z_$][\w$]*)/);
  if (publicClassMatch) {
    return publicClassMatch[1];
  }

  const classMatch = sourceCode.match(/\bclass\s+([A-Za-z_$][\w$]*)/);
  if (classMatch) {
    return classMatch[1];
  }

  throw new Error(
    'Unable to infer tester class name from tester.java. Pass --tester-class-name.',
  );
}

/**
 * Builds a dotted timestamp version accepted by the tester version comparator.
 * @returns {string} Version string.
 */
function buildTimestampVersion() {
  const now = new Date();
  return [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('.');
}

/**
 * Gets an access token from args/env or Auth0 client credentials.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<string>} Bearer token without prefix.
 */
async function resolveToken(runtime) {
  if (runtime.token) {
    return runtime.token;
  }

  if (
    !runtime.auth0Url ||
    !runtime.auth0ClientId ||
    !runtime.auth0ClientSecret ||
    !runtime.auth0Audience
  ) {
    throw new Error(
      'A bearer token is required. Pass --token/TOKEN or configure AUTH0_URL, AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, and AUTH0_AUDIENCE.',
    );
  }

  const payload = {
    client_id: runtime.auth0ClientId,
    client_secret: runtime.auth0ClientSecret,
    audience: runtime.auth0Audience,
    grant_type: 'client_credentials',
  };
  const response = await fetch(runtime.auth0Url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError('Failed to retrieve Auth0 token.', response.status, data);
  }

  const token = asNonEmptyString(data?.access_token);
  if (!token) {
    throw new Error('Auth0 token response did not include access_token.');
  }

  return token;
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
    throw new ApiError(`Request failed: ${options.method ?? 'GET'} ${url}`, response.status, body);
  }

  return body;
}

/**
 * Performs an authenticated multipart/form-data API request.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} url Request URL.
 * @param {FormData} form Form data.
 * @returns {Promise<unknown>} Parsed response body.
 */
async function requestForm(runtime, url, form) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${runtime.token}`,
      Accept: 'application/json',
    },
    body: form,
  });
  const body = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(`Request failed: POST ${url}`, response.status, body);
  }

  return body;
}

/**
 * Attempts an API request and returns null on 404.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} url Request URL.
 * @returns {Promise<unknown | null>} Parsed response body or null.
 */
async function requestJsonOrNull(runtime, url) {
  try {
    return await requestJson(runtime, url);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      return null;
    }

    throw error;
  }
}

/**
 * Waits until an async predicate returns a truthy value.
 * @param {string} label Wait label.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {() => Promise<unknown>} predicate Predicate to poll.
 * @returns {Promise<unknown>} Truthy predicate result.
 */
async function waitFor(label, runtime, predicate) {
  const startedAt = Date.now();
  let attempt = 0;

  while (Date.now() - startedAt <= runtime.waitTimeoutMs) {
    attempt += 1;
    const result = await predicate();
    if (result) {
      return result;
    }

    logStep(`Waiting for ${label}`, { attempt });
    await sleep(runtime.pollIntervalMs);
  }

  throw new Error(
    `Timed out waiting for ${label} after ${runtime.waitTimeoutMs}ms.`,
  );
}

/**
 * Sleeps for the requested duration.
 * @param {number} ms Duration in milliseconds.
 * @returns {Promise<void>} Resolves after the delay.
 */
function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

/**
 * Creates a challenge through challenge-api-v6 or loads a configured existing challenge.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifest Fixture manifest.
 * @returns {Promise<Record<string, unknown>>} Created or loaded challenge.
 */
async function createOrLoadChallenge(runtime, manifest) {
  const manifestChallenge = asRecord(manifest.challenge);
  const challengeId =
    runtime.challengeId ??
    asNonEmptyString(manifestChallenge.challengeId ?? manifestChallenge.id);
  if (challengeId) {
    runtime.challengeId = challengeId;
    logStep('Using existing challenge', { challengeId });
    return getChallenge(runtime);
  }

  const durations = resolveChallengePhaseDurations(runtime, manifestChallenge);
  const payload = await buildChallengeCreatePayload(runtime, manifestChallenge);
  logStep('Creating challenge', {
    name: payload.name,
    typeId: payload.typeId,
    trackId: payload.trackId,
    timelineTemplateId: payload.timelineTemplateId,
    registrationDurationSeconds: durations.registration,
    submissionDurationSeconds: durations.submission,
  });
  const response = await requestJson(runtime, joinUrl(runtime.challengeApiBase, 'challenges'), {
    method: 'POST',
    body: payload,
  });
  const challenge = unwrapChallengeResponse(response);
  const createdChallengeId = asNonEmptyString(challenge.id);
  if (!createdChallengeId) {
    throw new Error(`Challenge create response did not include id: ${JSON.stringify(response)}`);
  }

  runtime.challengeId = createdChallengeId;
  logStep('Created challenge', {
    challengeId: createdChallengeId,
    status: challenge.status,
  });
  return challenge;
}

/**
 * Builds the challenge-api-v6 create payload from defaults, manifest, and CLI overrides.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @returns {Promise<Record<string, unknown>>} Challenge create payload.
 */
async function buildChallengeCreatePayload(runtime, manifestChallenge) {
  const createPayload = asRecord(manifestChallenge.createPayload);
  const defaultFields = defaultChallengeCreateFields();
  const manifestFields = omitScriptChallengeFields(manifestChallenge);
  const payload = removeUndefinedProperties({
    ...defaultFields,
    ...manifestFields,
    ...createPayload,
    typeId:
      runtime.challengeTypeId ??
      asNonEmptyString(createPayload.typeId ?? manifestFields.typeId),
    trackId:
      runtime.challengeTrackId ??
      asNonEmptyString(createPayload.trackId ?? manifestFields.trackId),
    timelineTemplateId:
      runtime.timelineTemplateId ??
      asNonEmptyString(createPayload.timelineTemplateId ?? manifestFields.timelineTemplateId),
    projectId: toOptionalPositiveInteger(
      runtime.projectId ?? createPayload.projectId ?? manifestFields.projectId,
      'projectId',
    ),
    name:
      runtime.challengeName ??
      asNonEmptyString(createPayload.name ?? manifestFields.name) ??
      `Full Marathon Match Test ${new Date().toISOString()}`,
    description:
      runtime.challengeDescription ??
      asNonEmptyString(createPayload.description ?? manifestFields.description) ??
      defaultFields.description,
    privateDescription:
      runtime.challengePrivateDescription ??
      asNonEmptyString(createPayload.privateDescription ?? manifestFields.privateDescription) ??
      defaultFields.privateDescription,
  });

  if (!payload.typeId) {
    throw new Error(
      'Challenge creation requires --challenge-type-id, CHALLENGE_TYPE_ID, or manifest challenge.typeId.',
    );
  }
  if (!payload.trackId) {
    throw new Error(
      'Challenge creation requires --challenge-track-id, CHALLENGE_TRACK_ID, or manifest challenge.trackId.',
    );
  }

  payload.phases = await buildChallengePhaseOverrides(
    runtime,
    manifestChallenge,
    Array.isArray(payload.phases) ? payload.phases : [],
  );
  return payload;
}

/**
 * Provides conservative defaults for challenges created by this script.
 * @returns {Record<string, unknown>} Default challenge create fields.
 */
function defaultChallengeCreateFields() {
  return {
    legacy: { reviewType: 'INTERNAL' },
    name: `Full Marathon Match Test ${new Date().toISOString()}`,
    description: 'Full Marathon Match test challenge created by the Marathon Match API script.',
    privateDescription: 'Full Marathon Match test challenge.',
    descriptionFormat: 'markdown',
    challengeSource: 'Topcoder',
    metadata: [
      {
        name: 'createdByScript',
        value: 'scripts/run-full-marathon-match-test.mjs',
      },
    ],
    phases: [],
    events: [],
    discussions: [],
    prizeSets: [
      {
        type: 'PLACEMENT',
        description: 'Full Marathon Match test prizes',
        prizes: [
          {
            description: 'First place',
            type: 'USD',
            value: 1,
          },
        ],
      },
    ],
    tags: [],
    startDate: new Date().toISOString(),
    status: 'NEW',
    groups: [],
    terms: [],
    skills: [],
  };
}

/**
 * Removes script-only manifest keys before sending a challenge create payload.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @returns {Record<string, unknown>} Challenge API fields only.
 */
function omitScriptChallengeFields(manifestChallenge) {
  const fields = { ...manifestChallenge };
  for (const key of [
    'id',
    'challengeId',
    'createPayload',
    'config',
    'phaseDurations',
    'phaseIds',
    'registrationDurationSeconds',
    'registrationPhaseId',
    'source',
    'submissionDurationSeconds',
    'submissionPhaseId',
  ]) {
    delete fields[key];
  }

  return fields;
}

/**
 * Creates phase override rows for challenge-api-v6 creation.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @param {Array<Record<string, unknown>>} basePhases Existing payload phases.
 * @returns {Promise<Array<Record<string, unknown>>>} Phase overrides with MM durations.
 */
async function buildChallengePhaseOverrides(runtime, manifestChallenge, basePhases) {
  const durations = resolveChallengePhaseDurations(runtime, manifestChallenge);
  const registrationPhaseIds = await resolveCreatePhaseIds(runtime, manifestChallenge, 'registration', [
    'Registration',
  ]);
  const submissionPhaseIds = await resolveCreatePhaseIds(runtime, manifestChallenge, 'submission', [
    'Submission',
    'Marathon Match Submission',
    'Topgear Submission',
    'Topcoder Submission',
  ]);
  return mergeChallengePhaseOverrides(basePhases, [
    ...registrationPhaseIds.map((phaseId) => ({
      phaseId,
      duration: durations.registration,
    })),
    ...submissionPhaseIds.map((phaseId) => ({
      phaseId,
      duration: durations.submission,
    })),
  ]);
}

/**
 * Resolves configured or discovered phase definition IDs for challenge creation.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @param {string} key Phase key, such as registration or submission.
 * @param {string[]} candidateNames Phase names to discover through challenge-api.
 * @returns {Promise<string[]>} Phase definition IDs.
 */
async function resolveCreatePhaseIds(runtime, manifestChallenge, key, candidateNames) {
  const configured = getConfiguredCreatePhaseIds(runtime, manifestChallenge, key);
  if (configured.length > 0) {
    return configured;
  }

  const discovered = [];
  for (const phaseName of candidateNames) {
    const phase = await findPhaseDefinitionByName(runtime, phaseName);
    const phaseId = asNonEmptyString(phase?.id);
    if (phaseId) {
      discovered.push(phaseId);
    }
  }

  const unique = uniqueStrings(discovered);
  if (unique.length === 0) {
    throw new Error(
      `Unable to resolve ${key} phase ID from challenge-api-v6. Configure challenge.phaseIds.${key} or --${key}-phase-id.`,
    );
  }

  return unique;
}

/**
 * Reads explicit phase definition IDs from CLI/env or manifest.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @param {string} key Phase key.
 * @returns {string[]} Configured phase definition IDs.
 */
function getConfiguredCreatePhaseIds(runtime, manifestChallenge, key) {
  const runtimeValue = runtime[`${key}PhaseId`];
  const phaseIds = asRecord(manifestChallenge.phaseIds);
  return uniqueStrings([
    ...collectPhaseIds(runtimeValue),
    ...collectPhaseIds(phaseIds[key]),
    ...collectPhaseIds(phaseIds[`${key}PhaseId`]),
    ...collectPhaseIds(manifestChallenge[`${key}PhaseId`]),
  ]);
}

/**
 * Normalizes one configured phase ID field into a string list.
 * @param {unknown} value Configured ID or ID array.
 * @returns {string[]} Non-empty phase IDs.
 */
function collectPhaseIds(value) {
  if (Array.isArray(value)) {
    return value.map(asNonEmptyString).filter(Boolean);
  }

  const single = asNonEmptyString(value);
  return single ? [single] : [];
}

/**
 * Searches challenge-api-v6 phase definitions by exact phase name.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} phaseName Phase name.
 * @returns {Promise<Record<string, unknown> | null>} Phase definition or null.
 */
async function findPhaseDefinitionByName(runtime, phaseName) {
  const query = new URLSearchParams({
    name: phaseName,
    page: '1',
    perPage: '100',
  });
  const response = await requestJson(
    runtime,
    `${joinUrl(runtime.challengeApiBase, 'challenge-phases')}?${query}`,
  );
  const phases = extractSearchResultRecords(response);
  return (
    phases.find((phase) =>
      phase &&
      typeof phase === 'object' &&
      normalizeName(phase.name) === normalizeName(phaseName),
    ) ??
    null
  );
}

/**
 * Extracts records from known Topcoder search response envelopes.
 * @param {unknown} response API search response.
 * @returns {Array<Record<string, unknown>>} Search records.
 */
function extractSearchResultRecords(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (Array.isArray(response?.result?.content)) {
    return response.result.content;
  }
  if (Array.isArray(response?.result)) {
    return response.result;
  }
  if (Array.isArray(response?.data)) {
    return response.data;
  }

  return [];
}

/**
 * Resolves Registration and Submission durations for newly created challenges.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifestChallenge Manifest challenge object.
 * @returns {{ registration: number, submission: number }} Durations in seconds.
 */
function resolveChallengePhaseDurations(runtime, manifestChallenge) {
  const phaseDurations = asRecord(manifestChallenge.phaseDurations);
  const manifestRegistration = toOptionalNonNegativeInteger(
    manifestChallenge.registrationDurationSeconds ??
      phaseDurations.registration ??
      phaseDurations.registrationDurationSeconds,
    'challenge.registrationDurationSeconds',
  );
  const manifestSubmission = toOptionalNonNegativeInteger(
    manifestChallenge.submissionDurationSeconds ??
      phaseDurations.submission ??
      phaseDurations.submissionDurationSeconds,
    'challenge.submissionDurationSeconds',
  );

  return {
    registration: runtime.registrationDurationSecondsExplicit
      ? runtime.registrationDurationSeconds
      : manifestRegistration ?? runtime.registrationDurationSeconds,
    submission: runtime.submissionDurationSecondsExplicit
      ? runtime.submissionDurationSeconds
      : manifestSubmission ?? runtime.submissionDurationSeconds,
  };
}

/**
 * Applies duration overrides to challenge create phase rows.
 * @param {Array<Record<string, unknown>>} basePhases Existing payload phases.
 * @param {Array<Record<string, unknown>>} overrides Phase duration overrides.
 * @returns {Array<Record<string, unknown>>} Merged phase rows.
 */
function mergeChallengePhaseOverrides(basePhases, overrides) {
  const phases = basePhases.map((phase, index) => normalizeCreatePhase(phase, index));
  const byPhaseId = new Map(
    phases
      .map((phase) => [asNonEmptyString(phase.phaseId), phase])
      .filter(([phaseId]) => phaseId),
  );

  for (const override of overrides) {
    const phaseId = asNonEmptyString(override.phaseId);
    if (!phaseId) {
      throw new Error(`Phase override is missing phaseId: ${JSON.stringify(override)}`);
    }

    const duration = toOptionalNonNegativeInteger(
      override.duration,
      `phase ${phaseId} duration`,
    );
    if (duration === undefined) {
      throw new Error(`Phase override ${phaseId} is missing duration.`);
    }

    const existing = byPhaseId.get(phaseId);
    if (existing) {
      existing.duration = duration;
    } else {
      const phase = { phaseId, duration };
      phases.push(phase);
      byPhaseId.set(phaseId, phase);
    }
  }

  return phases;
}

/**
 * Normalizes one phase row from a manifest or create payload.
 * @param {unknown} phase Phase row.
 * @param {number} index Phase row index.
 * @returns {Record<string, unknown>} Normalized phase row.
 */
function normalizeCreatePhase(phase, index) {
  if (!phase || typeof phase !== 'object' || Array.isArray(phase)) {
    throw new Error(`Challenge phase at index ${index} must be an object.`);
  }

  return removeUndefinedProperties({ ...phase });
}

/**
 * Converts a value to an optional non-negative integer.
 * @param {unknown} value Candidate value.
 * @param {string} label Label for error messages.
 * @returns {number | undefined} Parsed integer when present.
 */
function toOptionalNonNegativeInteger(value, label) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }

  return parsed;
}

/**
 * Converts a value to an optional positive integer.
 * @param {unknown} value Candidate value.
 * @param {string} label Label for error messages.
 * @returns {number | undefined} Parsed integer when present.
 */
function toOptionalPositiveInteger(value, label) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }

  return parsed;
}

/**
 * Returns a shallow copy without undefined values.
 * @param {Record<string, unknown>} record Source record.
 * @returns {Record<string, unknown>} Record without undefined values.
 */
function removeUndefinedProperties(record) {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined),
  );
}

/**
 * Converts an object-like value to a plain record, otherwise an empty record.
 * @param {unknown} value Candidate value.
 * @returns {Record<string, unknown>} Record value.
 */
function asRecord(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }

  return {};
}

/**
 * Removes duplicate strings while preserving first-seen order.
 * @param {Array<string | undefined>} values Candidate values.
 * @returns {string[]} Unique non-empty strings.
 */
function uniqueStrings(values) {
  return Array.from(new Set(values.map(asNonEmptyString).filter(Boolean)));
}

/**
 * Creates or reuses a compiled tester.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} tester Tester fixture.
 * @returns {Promise<Record<string, unknown>>} Compiled tester response.
 */
async function createAndWaitForTester(runtime, tester) {
  if (runtime.reuseTester) {
    const existing = await findTesterByName(runtime, tester.name);
    if (existing?.compilationStatus === 'SUCCESS') {
      logStep('Reusing existing compiled tester', {
        testerId: existing.id,
        name: existing.name,
        version: existing.version,
      });
      return existing;
    }
  }

  const created = await createTesterRecord(runtime, tester);

  const testerId = created.id;
  return waitFor(`tester ${testerId} compilation`, runtime, async () => {
    const current = await requestJson(
      runtime,
      joinUrl(runtime.mmApiBase, 'testers', testerId),
    );
    if (current.compilationStatus === 'FAILED') {
      throw new Error(
        `Tester compilation failed: ${current.compilationError ?? '<no error detail>'}`,
      );
    }

    if (current.compilationStatus === 'SUCCESS') {
      logStep('Tester compiled successfully', { testerId });
      return current;
    }

    return null;
  });
}

/**
 * Creates a tester record or publishes a new version when the family exists.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} tester Tester fixture.
 * @returns {Promise<Record<string, unknown>>} Created tester response.
 */
async function createTesterRecord(runtime, tester) {
  logStep('Creating tester', {
    name: tester.name,
    version: tester.version,
    className: tester.className,
  });

  try {
    return await requestJson(runtime, joinUrl(runtime.mmApiBase, 'testers'), {
      method: 'POST',
      body: {
        name: tester.name,
        version: tester.version,
        className: tester.className,
        sourceCode: tester.sourceCode,
      },
    });
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 409) {
      throw error;
    }

    const existing = await findTesterByName(runtime, tester.name);
    if (!existing?.id) {
      throw error;
    }

    const version = `9999.${buildTimestampVersion()}`;
    logStep('Tester family exists; publishing a new tester version', {
      existingTesterId: existing.id,
      name: tester.name,
      version,
    });
    return requestJson(runtime, joinUrl(runtime.mmApiBase, 'testers', existing.id), {
      method: 'PUT',
      body: {
        version,
        className: tester.className,
        sourceCode: tester.sourceCode,
      },
    });
  }
}

/**
 * Finds the most recently updated tester with a matching name.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} testerName Tester family name.
 * @returns {Promise<Record<string, unknown> | null>} Tester summary or null.
 */
async function findTesterByName(runtime, testerName) {
  const query = new URLSearchParams({
    name: testerName,
    page: '1',
    perPage: '100',
  });
  const response = await requestJson(
    runtime,
    `${joinUrl(runtime.mmApiBase, 'testers')}?${query}`,
  );
  const testers = Array.isArray(response?.testers) ? response.testers : [];
  return testers
    .filter((tester) => tester.name === testerName)
    .sort((left, right) =>
      String(right.updatedAt ?? '').localeCompare(String(left.updatedAt ?? '')),
    )[0] ?? null;
}

/**
 * Loads config defaults from Marathon Match API.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Defaults response.
 */
async function getMarathonDefaults(runtime) {
  try {
    return await requestJson(runtime, joinUrl(runtime.mmApiBase, 'challenge/defaults'));
  } catch (error) {
    if (runtime.reviewScorecardId && runtime.taskDefinitionName && runtime.taskDefinitionVersion) {
      return {};
    }

    throw error;
  }
}

/**
 * Resolves phase IDs required by Marathon Match config and lifecycle actions.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} manifest Fixture manifest.
 * @returns {Promise<Record<string, unknown>>} Phase details.
 */
async function resolvePhases(runtime, manifest) {
  const challenge = await getChallenge(runtime);
  const phases = extractChallengePhases(challenge);
  const configuredPhaseIds = manifest.phaseIds ?? manifest.challenge?.phaseIds ?? {};
  const registration = findPhaseByNames(phases, ['Registration']);
  const submission = findPhaseByNames(phases, [
    'Submission',
    'Marathon Match Submission',
    'Topgear Submission',
  ]);
  const review = findPhaseByNames(phases, ['Review']);

  if (!submission) {
    throw new Error('Unable to resolve Submission phase from challenge details.');
  }

  if (!review) {
    throw new Error('Unable to resolve Review phase from challenge details.');
  }

  return {
    challenge,
    phases,
    registration,
    submission,
    review,
    examplePhaseId:
      getConfiguredPhaseId(configuredPhaseIds, 'example') ?? getPhaseIdentifier(submission),
    provisionalPhaseId:
      getConfiguredPhaseId(configuredPhaseIds, 'provisional') ?? getPhaseIdentifier(submission),
    systemPhaseId:
      getConfiguredPhaseId(configuredPhaseIds, 'system') ?? getPhaseIdentifier(review),
  };
}

/**
 * Loads a challenge from Challenge API.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown>>} Challenge payload.
 */
async function getChallenge(runtime) {
  const response = await requestJson(
    runtime,
    joinUrl(runtime.challengeApiBase, 'challenges', runtime.challengeId),
  );
  return unwrapChallengeResponse(response);
}

/**
 * Unwraps known Challenge API response envelopes.
 * @param {unknown} response Raw response.
 * @returns {Record<string, unknown>} Challenge payload.
 */
function unwrapChallengeResponse(response) {
  if (response?.result?.content) {
    return response.result.content;
  }

  if (response?.result && typeof response.result === 'object') {
    return response.result;
  }

  return response;
}

/**
 * Extracts challenge phase rows from a challenge response.
 * @param {Record<string, unknown>} challenge Challenge payload.
 * @returns {Array<Record<string, unknown>>} Phase rows.
 */
function extractChallengePhases(challenge) {
  return Array.isArray(challenge.phases) ? challenge.phases : [];
}

/**
 * Finds a phase by any of the provided names.
 * @param {Array<Record<string, unknown>>} phases Challenge phases.
 * @param {string[]} names Candidate names.
 * @returns {Record<string, unknown> | null} Matching phase or null.
 */
function findPhaseByNames(phases, names) {
  const normalizedNames = new Set(names.map(normalizeName));
  return (
    phases.find((phase) =>
      normalizedNames.has(
        normalizeName(phase.name ?? phase.phaseName ?? phase.type ?? ''),
      ),
    ) ?? null
  );
}

/**
 * Normalizes a phase or role name for matching.
 * @param {unknown} value Candidate name.
 * @returns {string} Normalized name.
 */
function normalizeName(value) {
  return String(value ?? '').trim().toLowerCase();
}

/**
 * Returns a configured phase ID from a phase ID object.
 * @param {Record<string, unknown>} configuredPhaseIds Configured phase IDs.
 * @param {string} key Phase key.
 * @returns {string | undefined} Phase ID.
 */
function getConfiguredPhaseId(configuredPhaseIds, key) {
  return asNonEmptyString(configuredPhaseIds[key] ?? configuredPhaseIds[`${key}PhaseId`]);
}

/**
 * Gets the canonical phase identifier accepted by Marathon Match config.
 * @param {Record<string, unknown>} phase Challenge phase row.
 * @returns {string} Phase identifier.
 */
function getPhaseIdentifier(phase) {
  const phaseId = asNonEmptyString(phase.phaseId ?? phase.id);
  if (!phaseId) {
    throw new Error(`Phase is missing phaseId/id: ${JSON.stringify(phase)}`);
  }

  return phaseId;
}

/**
 * Gets the challenge-phase row ID for submission metadata when available.
 * @param {Record<string, unknown>} phase Challenge phase row.
 * @returns {string | undefined} Phase instance ID, falling back to canonical phaseId.
 */
function getChallengePhaseInstanceId(phase) {
  return asNonEmptyString(phase.id ?? phase.phaseId);
}

/**
 * Creates or updates the Marathon Match challenge config.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} fixture Fixture data.
 * @param {Record<string, unknown>} compiledTester Tester response.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {Promise<Record<string, unknown> | null>} Config response or null.
 */
async function upsertMarathonConfig(runtime, fixture, compiledTester, phases) {
  if (runtime.skipConfig) {
    logStep('Skipping Marathon Match config create/update');
    return null;
  }

  const defaults = await getMarathonDefaults(runtime);
  const manifestConfig = fixture.manifest.config ?? fixture.manifest.challenge?.config ?? {};
  const payload = {
    name:
      asNonEmptyString(manifestConfig.name) ??
      `Full MM Test Config ${runtime.challengeId}`,
    active: false,
    relativeScoringEnabled:
      typeof manifestConfig.relativeScoringEnabled === 'boolean'
        ? manifestConfig.relativeScoringEnabled
        : true,
    scoreDirection: asNonEmptyString(manifestConfig.scoreDirection) ?? 'MAXIMIZE',
    submissionApiUrl: runtime.reviewApiBase,
    reviewScorecardId:
      runtime.reviewScorecardId ??
      asNonEmptyString(manifestConfig.reviewScorecardId) ??
      defaults.reviewScorecardId,
    testerId: compiledTester.id,
    testTimeout:
      Number(manifestConfig.testTimeout ?? runtime.testTimeout),
    compileTimeout:
      Number(manifestConfig.compileTimeout ?? runtime.compileTimeout),
    taskDefinitionName:
      runtime.taskDefinitionName ??
      asNonEmptyString(manifestConfig.taskDefinitionName) ??
      defaults.taskDefinitionName,
    taskDefinitionVersion: String(
      runtime.taskDefinitionVersion ??
        asNonEmptyString(manifestConfig.taskDefinitionVersion) ??
        defaults.taskDefinitionVersion ??
        '',
    ),
    example: {
      configType: 'EXAMPLE',
      phaseId: phases.examplePhaseId,
      startSeed: Number(manifestConfig.example?.startSeed ?? runtime.exampleStartSeed),
      numberOfTests: Number(
        manifestConfig.example?.numberOfTests ?? runtime.exampleNumberOfTests,
      ),
    },
    provisional: {
      configType: 'PROVISIONAL',
      phaseId: phases.provisionalPhaseId,
      startSeed: Number(
        manifestConfig.provisional?.startSeed ?? runtime.provisionalStartSeed,
      ),
      numberOfTests: Number(
        manifestConfig.provisional?.numberOfTests ??
          runtime.provisionalNumberOfTests,
      ),
    },
    system: {
      configType: 'SYSTEM',
      phaseId: phases.systemPhaseId,
      startSeed: Number(manifestConfig.system?.startSeed ?? runtime.systemStartSeed),
      numberOfTests: Number(
        manifestConfig.system?.numberOfTests ?? runtime.systemNumberOfTests,
      ),
    },
  };

  for (const required of [
    'reviewScorecardId',
    'taskDefinitionName',
    'taskDefinitionVersion',
  ]) {
    if (!payload[required]) {
      throw new Error(
        `Marathon Match config requires ${required}. Pass --${required.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} or configure defaults.`,
      );
    }
  }

  const configUrl = joinUrl(runtime.mmApiBase, 'challenge', runtime.challengeId);
  const existing = await requestJsonOrNull(runtime, configUrl);
  if (existing) {
    logStep('Updating Marathon Match config', { challengeId: runtime.challengeId });
    return requestJson(runtime, configUrl, {
      method: 'PUT',
      body: payload,
    });
  }

  logStep('Creating Marathon Match config', { challengeId: runtime.challengeId });
  return requestJson(runtime, configUrl, {
    method: 'POST',
    body: payload,
  });
}

/**
 * Approves a challenge before launch activation.
 * @param {Record<string, unknown>} runtime Runtime configuration with challenge API base, token, and challenge ID.
 * @returns {Promise<void>} Resolves when the approval PATCH succeeds.
 * @throws {ApiError} When Challenge API rejects the approval request.
 */
async function approveChallengeForLaunch(runtime) {
  logStep('Approving challenge', { challengeId: runtime.challengeId });
  await requestJson(runtime, joinUrl(runtime.challengeApiBase, 'challenges', runtime.challengeId), {
    method: 'PATCH',
    body: { approvalStatus: 'APPROVED' },
  });
}

/**
 * Approves and activates a challenge, then opens Registration when requested.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {Promise<void>} Resolves when launch steps finish.
 * @throws {ApiError} When Challenge API rejects an approval, activation, or phase request.
 */
async function launchChallenge(runtime, phases) {
  if (runtime.skipChallengeLaunch) {
    logStep('Skipping challenge launch');
    return;
  }

  const challenge = await getChallenge(runtime);
  if (String(challenge.status ?? '').toUpperCase() !== 'ACTIVE') {
    await approveChallengeForLaunch(runtime);
    logStep('Activating challenge', { challengeId: runtime.challengeId });
    await requestJson(runtime, joinUrl(runtime.challengeApiBase, 'challenges', runtime.challengeId), {
      method: 'PATCH',
      body: { status: 'ACTIVE' },
    });
  }

  if (!runtime.skipPhaseAdvance && phases.registration) {
    await ensurePhaseState(runtime, 'Registration', true);
  }
}

/**
 * Opens or closes a named challenge phase.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} phaseName Phase name.
 * @param {boolean} shouldBeOpen Desired open state.
 * @returns {Promise<void>} Resolves when the phase reaches the desired state.
 */
async function ensurePhaseState(runtime, phaseName, shouldBeOpen) {
  const challenge = await getChallenge(runtime);
  const phase = findPhaseByNames(extractChallengePhases(challenge), [phaseName]);
  if (!phase) {
    throw new Error(`Challenge does not include phase ${phaseName}.`);
  }

  if (Boolean(phase.isOpen) === shouldBeOpen) {
    logStep(`Phase ${phaseName} already ${shouldBeOpen ? 'open' : 'closed'}`);
    return;
  }

  const operation = shouldBeOpen ? 'open' : 'close';
  logStep(`${operation === 'open' ? 'Opening' : 'Closing'} phase`, {
    phase: phaseName,
  });
  await requestJson(
    runtime,
    joinUrl(runtime.challengeApiBase, 'challenges', runtime.challengeId, 'advance-phase'),
    {
      method: 'POST',
      body: {
        phase: phaseName,
        operation,
      },
    },
  );
}

/**
 * Resolves the submitter resource role ID.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<string>} Submitter role ID.
 */
async function resolveSubmitterRoleId(runtime) {
  if (runtime.submitterRoleId) {
    return runtime.submitterRoleId;
  }

  const roles = await requestJson(
    runtime,
    `${joinUrl(runtime.resourceApiBase, 'resource-roles')}?name=Submitter`,
  );
  const submitterRole = Array.isArray(roles)
    ? roles.find((role) => normalizeName(role.name) === 'submitter')
    : null;
  if (!submitterRole?.id) {
    throw new Error(
      'Unable to resolve Submitter resource role. Pass --submitter-role-id.',
    );
  }

  return submitterRole.id;
}

/**
 * Registers fixture users as challenge submitters.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Array<Record<string, unknown>>} submissions Submission fixtures.
 * @returns {Promise<void>} Resolves after registration.
 */
async function registerSubmitters(runtime, submissions) {
  if (runtime.skipRegistration) {
    logStep('Skipping submitter registration');
    return;
  }

  const submitterRoleId = await resolveSubmitterRoleId(runtime);
  const users = uniqueUsers(submissions);
  logStep('Registering submitters', { count: users.length });

  for (const user of users) {
    const payload = {
      challengeId: runtime.challengeId,
      memberId: user.memberId,
      ...(user.memberHandle ? { memberHandle: user.memberHandle } : {}),
      roleId: submitterRoleId,
      sendEmail: false,
    };

    try {
      await requestJson(runtime, joinUrl(runtime.resourceApiBase, 'resources'), {
        method: 'POST',
        body: payload,
      });
      logStep('Registered submitter', {
        memberId: user.memberId,
        memberHandle: user.memberHandle,
      });
    } catch (error) {
      if (isAlreadyRegisteredError(error)) {
        logStep('Submitter already registered', {
          memberId: user.memberId,
          memberHandle: user.memberHandle,
        });
        continue;
      }

      throw error;
    }
  }
}

/**
 * Reduces submission entries to unique member records.
 * @param {Array<Record<string, unknown>>} submissions Submission fixtures.
 * @returns {Array<Record<string, string | undefined>>} Unique users.
 */
function uniqueUsers(submissions) {
  const usersByMemberId = new Map();
  for (const submission of submissions) {
    const memberId = asNonEmptyString(submission.memberId);
    if (!memberId) {
      throw new Error(`Submission entry is missing memberId: ${JSON.stringify(submission)}`);
    }

    if (!usersByMemberId.has(memberId)) {
      usersByMemberId.set(memberId, {
        memberId,
        memberHandle: asNonEmptyString(submission.memberHandle),
      });
    }
  }

  return Array.from(usersByMemberId.values());
}

/**
 * Detects duplicate-resource responses from resource-api.
 * @param {unknown} error Error thrown by requestJson.
 * @returns {boolean} True when the user already has the submitter resource.
 */
function isAlreadyRegisteredError(error) {
  if (!(error instanceof ApiError)) {
    return false;
  }

  const message = JSON.stringify(error.body ?? '').toLowerCase();
  return (
    [400, 409].includes(error.status) &&
    (message.includes('already has resource') ||
      message.includes('duplicate') ||
      message.includes('already exist'))
  );
}

/**
 * Activates Marathon Match config before submissions are sent.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<void>} Resolves when config is active.
 */
async function activateMarathonConfig(runtime) {
  if (runtime.skipConfig) {
    logStep('Skipping Marathon Match config activation');
    return;
  }

  logStep('Activating Marathon Match config', { challengeId: runtime.challengeId });
  await requestJson(runtime, joinUrl(runtime.mmApiBase, 'challenge', runtime.challengeId), {
    method: 'PUT',
    body: { active: true },
  });
}

/**
 * Uploads and submits all fixture submissions.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Array<Record<string, unknown>>} submissions Submission fixtures.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {Promise<Array<Record<string, unknown>>>} Created submission records.
 */
async function createSubmissions(runtime, submissions, phases) {
  const created = [];
  for (const submission of submissions) {
    let response;
    if (runtime.manualSubmissionUpload && submission.file) {
      response = await createManualUploadedSubmission(runtime, submission, phases);
    } else {
      const url = await resolveSubmissionUrl(runtime, submission);
      const payload = buildSubmissionPayload(runtime, submission, phases);
      payload.url = url;

      logStep('Creating submission', {
        memberId: submission.memberId,
        memberHandle: submission.memberHandle,
        file: submission.file ? basename(submission.file) : undefined,
      });
      response = await requestJson(
        runtime,
        joinUrl(runtime.reviewApiBase, 'submissions'),
        {
          method: 'POST',
          body: payload,
        },
      );
    }

    created.push({
      ...submission,
      submissionId: response.id,
      submittedDate: response.submittedDate ?? submission.submittedDate,
      createdSubmission: response,
    });
    logStep('Created submission', {
      submissionId: response.id,
      memberId: response.memberId,
    });
  }

  return created;
}

/**
 * Creates one submission through review-api's privileged manual upload endpoint.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} submission Submission fixture with a local file.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {Promise<Record<string, unknown>>} Created submission response.
 */
async function createManualUploadedSubmission(runtime, submission, phases) {
  await assertReadableFile(submission.file);
  const form = buildSubmissionForm(runtime, submission, phases);
  const fileName = basename(submission.file);
  form.set('fileName', fileName);
  form.set(
    'file',
    new Blob([await readFile(submission.file)], {
      type: guessContentType(submission.file),
    }),
    fileName,
  );

  logStep('Creating manual upload submission', {
    memberId: submission.memberId,
    memberHandle: submission.memberHandle,
    file: fileName,
  });

  return requestForm(
    runtime,
    joinUrl(runtime.reviewApiBase, 'submissions', 'manual-upload'),
    form,
  );
}

/**
 * Builds common submission form fields shared by normal and manual upload flows.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} submission Submission fixture.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {FormData} Multipart form data with common fields set.
 */
function buildSubmissionForm(runtime, submission, phases) {
  const form = new FormData();
  const payload = buildSubmissionPayload(runtime, submission, phases);
  for (const [key, value] of Object.entries(payload)) {
    form.set(key, String(value));
  }

  return form;
}

/**
 * Builds common submission fields shared by JSON and manual multipart flows.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} submission Submission fixture.
 * @param {Record<string, unknown>} phases Phase data.
 * @returns {Record<string, string>} Common submission payload fields.
 */
function buildSubmissionPayload(runtime, submission, phases) {
  const payload = {
    type: asNonEmptyString(submission.type) ?? runtime.submissionType,
    challengeId: runtime.challengeId,
    memberId: asNonEmptyString(submission.memberId),
  };
  const submissionPhaseId =
    asNonEmptyString(submission.submissionPhaseId) ??
    getChallengePhaseInstanceId(phases.submission);
  if (submissionPhaseId) {
    payload.submissionPhaseId = submissionPhaseId;
  }
  if (submission.submittedDate) {
    payload.submittedDate = String(submission.submittedDate);
  }

  return payload;
}

/**
 * Resolves a submission URL, uploading local files to S3 when needed.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} submission Submission fixture.
 * @returns {Promise<string>} Submission URL.
 */
async function resolveSubmissionUrl(runtime, submission) {
  if (submission.url) {
    return submission.url;
  }

  if (!submission.file) {
    throw new Error(`Submission for member ${submission.memberId} has no file or url.`);
  }

  if (!runtime.submissionUploadBucket) {
    throw new Error(
      `Submission ${submission.file} is local. Configure --submission-upload-bucket or provide url in the manifest.`,
    );
  }

  await assertReadableFile(submission.file);
  const key = buildSubmissionS3Key(runtime, submission);
  const s3 = new S3Client({});
  const fileInfo = await stat(submission.file);
  await s3.send(
    new PutObjectCommand({
      Bucket: runtime.submissionUploadBucket,
      Key: key,
      Body: createReadStream(submission.file),
      ContentLength: fileInfo.size,
      ContentType: guessContentType(submission.file),
    }),
  );

  const url = runtime.submissionUploadBaseUrl
    ? joinUrl(runtime.submissionUploadBaseUrl, key)
    : buildS3HttpsUrl(runtime.submissionUploadBucket, key);
  logStep('Uploaded submission fixture', {
    file: submission.file,
    bucket: runtime.submissionUploadBucket,
    key,
  });
  return url;
}

/**
 * Verifies a file exists and is readable.
 * @param {string} path File path.
 * @returns {Promise<void>} Resolves when readable.
 */
async function assertReadableFile(path) {
  const fileInfo = await stat(path);
  if (!fileInfo.isFile()) {
    throw new Error(`${path} is not a file.`);
  }
}

/**
 * Builds an S3 key for one submission fixture upload.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} submission Submission fixture.
 * @returns {string} S3 object key.
 */
function buildSubmissionS3Key(runtime, submission) {
  const safeFileName = basename(submission.file).replace(/[^A-Za-z0-9._-]/g, '_');
  const memberId = asNonEmptyString(submission.memberId);
  const index = String(submission.fixtureIndex ?? 0).padStart(3, '0');
  return [
    runtime.submissionUploadPrefix,
    runtime.challengeId,
    memberId,
    `${Date.now()}-${index}-${safeFileName}`,
  ]
    .filter(Boolean)
    .join('/');
}

/**
 * Builds a public-style S3 HTTPS URL for a bucket/key.
 * @param {string} bucket S3 bucket.
 * @param {string} key S3 key.
 * @returns {string} HTTPS URL.
 */
function buildS3HttpsUrl(bucket, key) {
  return `https://s3.amazonaws.com/${bucket}/${key
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;
}

/**
 * Guesses a content type from a file extension.
 * @param {string} filePath File path.
 * @returns {string} Content type.
 */
function guessContentType(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === '.zip') {
    return 'application/zip';
  }
  if (extension === '.jar') {
    return 'application/java-archive';
  }
  if (extension === '.txt') {
    return 'text/plain';
  }

  return 'application/octet-stream';
}

/**
 * Polls all created submissions until provisional scoring is visible.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Array<Record<string, unknown>>} submissions Created submissions.
 * @returns {Promise<void>} Resolves when all submissions are scored.
 */
async function waitForSubmissionPhaseScoring(runtime, submissions) {
  for (const submission of submissions) {
    await waitFor(`provisional scoring for ${submission.submissionId}`, runtime, async () => {
      const provisional = await getSummations(runtime, {
        submissionId: submission.submissionId,
        provisional: true,
      });
      const artifacts = await getArtifacts(runtime, submission.submissionId);
      const expectedScore = getExpectedScore(submission, 'provisional');
      const scored = provisional.length > 0 && hasValidScore(provisional[0]);
      const artifactsReady = artifacts.length >= runtime.minArtifacts;
      if (scored && expectedScore !== undefined) {
        assertScoreClose(
          provisional[0].aggregateScore,
          expectedScore,
          runtime.scoreTolerance,
          `provisional score for ${submission.submissionId}`,
        );
      }

      if (scored && runtime.requireTestScores) {
        assertHasTestScores(provisional[0], `provisional ${submission.submissionId}`);
      }

      if (scored && artifactsReady) {
        logStep('Submission phase scoring complete', {
          submissionId: submission.submissionId,
          score: provisional[0].aggregateScore,
          artifactCount: artifacts.length,
        });
        return true;
      }

      return false;
    });
  }
}

/**
 * Polls latest submissions until SYSTEM scoring is visible.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Array<Record<string, unknown>>} submissions Created submissions.
 * @returns {Promise<Array<Record<string, unknown>>>} Latest submissions.
 */
async function waitForSystemScoring(runtime, submissions) {
  const latest = latestSubmissionsByMember(submissions);
  for (const submission of latest) {
    await waitFor(`SYSTEM scoring for ${submission.submissionId}`, runtime, async () => {
      const system = await getSummations(runtime, {
        submissionId: submission.submissionId,
        system: true,
      });
      const expectedScore = getExpectedScore(submission, 'system');
      const scored = system.length > 0 && hasValidScore(system[0]);
      if (scored && expectedScore !== undefined) {
        assertScoreClose(
          system[0].aggregateScore,
          expectedScore,
          runtime.scoreTolerance,
          `system score for ${submission.submissionId}`,
        );
      }

      if (scored && runtime.requireTestScores) {
        assertHasTestScores(system[0], `system ${submission.submissionId}`);
      }

      if (scored) {
        logStep('SYSTEM scoring complete', {
          submissionId: submission.submissionId,
          score: system[0].aggregateScore,
        });
        return true;
      }

      return false;
    });
  }

  return latest;
}

/**
 * Loads review summations for one submission.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {Record<string, unknown>} query Query filters.
 * @returns {Promise<Array<Record<string, unknown>>>} Summation rows.
 */
async function getSummations(runtime, query) {
  const params = new URLSearchParams({
    submissionId: query.submissionId,
    metadata: 'true',
    perPage: '100',
  });
  if (query.provisional) {
    params.set('provisional', 'true');
  }
  if (query.example) {
    params.set('example', 'true');
  }
  if (query.system) {
    params.set('system', 'true');
  }

  const response = await requestJson(
    runtime,
    `${joinUrl(runtime.reviewApiBase, 'reviewSummations')}?${params}`,
  );
  return Array.isArray(response?.data) ? response.data : [];
}

/**
 * Loads artifacts attached to a submission.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @param {string} submissionId Submission ID.
 * @returns {Promise<string[]>} Artifact IDs.
 */
async function getArtifacts(runtime, submissionId) {
  const response = await requestJson(
    runtime,
    joinUrl(runtime.reviewApiBase, 'submissions', submissionId, 'artifacts'),
  );
  return Array.isArray(response?.artifacts) ? response.artifacts : [];
}

/**
 * Checks whether a summation has a numeric aggregate score.
 * @param {Record<string, unknown>} summation Review summation.
 * @returns {boolean} True when score is numeric.
 */
function hasValidScore(summation) {
  return typeof summation.aggregateScore === 'number' && Number.isFinite(summation.aggregateScore);
}

/**
 * Gets an optional expected score from a submission fixture.
 * @param {Record<string, unknown>} submission Submission fixture.
 * @param {string} phase Score phase.
 * @returns {number | undefined} Expected score.
 */
function getExpectedScore(submission, phase) {
  const expectedScores = submission.expectedScores ?? submission.expected ?? {};
  const value = expectedScores[phase] ?? submission[`${phase}Score`];
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected ${phase} score must be numeric for ${submission.submissionId}.`);
  }

  return parsed;
}

/**
 * Asserts an actual score is within tolerance.
 * @param {number} actual Actual score.
 * @param {number} expected Expected score.
 * @param {number} tolerance Allowed difference.
 * @param {string} label Assertion label.
 * @returns {void}
 */
function assertScoreClose(actual, expected, tolerance, label) {
  if (Math.abs(actual - expected) > tolerance) {
    throw new Error(`${label} expected ${expected} but got ${actual}.`);
  }
}

/**
 * Asserts a summation includes metadata.testScores.
 * @param {Record<string, unknown>} summation Review summation.
 * @param {string} label Assertion label.
 * @returns {void}
 */
function assertHasTestScores(summation, label) {
  const testScores = summation.metadata?.testScores;
  if (!Array.isArray(testScores) || testScores.length === 0) {
    throw new Error(`${label} is missing metadata.testScores.`);
  }
}

/**
 * Selects the latest created submission for every member.
 * @param {Array<Record<string, unknown>>} submissions Created submissions.
 * @returns {Array<Record<string, unknown>>} Latest submissions.
 */
function latestSubmissionsByMember(submissions) {
  const latest = new Map();
  for (const submission of submissions) {
    const memberId = asNonEmptyString(submission.memberId);
    const current = latest.get(memberId);
    if (!current || getSubmissionSortValue(submission) >= getSubmissionSortValue(current)) {
      latest.set(memberId, submission);
    }
  }

  return Array.from(latest.values());
}

/**
 * Computes a stable sort value for a created submission.
 * @param {Record<string, unknown>} submission Submission fixture/result.
 * @returns {number} Sort timestamp.
 */
function getSubmissionSortValue(submission) {
  const raw =
    submission.createdSubmission?.submittedDate ??
    submission.createdSubmission?.createdAt ??
    submission.submittedDate;
  const timestamp = new Date(String(raw ?? '')).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number(submission.fixtureIndex ?? 0);
}

/**
 * Waits for autopilot to close Review and complete the Marathon Match.
 * @param {Record<string, unknown>} runtime Runtime configuration.
 * @returns {Promise<Record<string, unknown> | null>} Completed challenge response.
 */
async function waitForAutopilotCompletion(runtime) {
  if (runtime.skipFinalClose) {
    logStep('Skipping final autopilot completion wait');
    return null;
  }

  await waitFor('autopilot Review phase closure', runtime, async () => {
    const challenge = await getChallenge(runtime);
    const reviewPhase = findPhaseByNames(extractChallengePhases(challenge), [
      'Review',
    ]);
    if (!reviewPhase) {
      throw new Error('Challenge does not include a Review phase.');
    }

    if (!reviewPhase.isOpen) {
      logStep('Review phase closed by autopilot', {
        challengeId: runtime.challengeId,
        phaseId: reviewPhase.id,
      });
      return challenge;
    }

    return null;
  });

  return waitFor('autopilot challenge COMPLETED status', runtime, async () => {
    const challenge = await getChallenge(runtime);
    if (String(challenge.status ?? '').toUpperCase() === 'COMPLETED') {
      logStep('Challenge completed by autopilot', {
        challengeId: runtime.challengeId,
      });
      return challenge;
    }

    return null;
  });
}

/**
 * Runs the full Marathon Match integration flow.
 * @returns {Promise<void>} Resolves when the flow completes successfully.
 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtime = buildRuntimeConfig(args);
  runtime.token = await resolveToken(runtime);
  const fixture = await loadFixture(runtime);

  logStep('Loaded fixture', {
    fixtureDir: runtime.fixtureDir,
    submissions: fixture.submissions.length,
    testerClassName: fixture.tester.className,
  });

  await createOrLoadChallenge(runtime, fixture.manifest);
  const compiledTester = await createAndWaitForTester(runtime, fixture.tester);
  const phases = await resolvePhases(runtime, fixture.manifest);
  await upsertMarathonConfig(runtime, fixture, compiledTester, phases);
  await launchChallenge(runtime, phases);
  await registerSubmitters(runtime, fixture.submissions);
  await activateMarathonConfig(runtime);

  if (!runtime.skipPhaseAdvance) {
    if (phases.registration) {
      await ensurePhaseState(runtime, 'Registration', false);
    }
    await ensurePhaseState(runtime, 'Submission', true);
  }

  const createdSubmissions = await createSubmissions(
    runtime,
    fixture.submissions,
    phases,
  );
  await waitForSubmissionPhaseScoring(runtime, createdSubmissions);

  if (!runtime.skipPhaseAdvance) {
    await ensurePhaseState(runtime, 'Submission', false);
    await ensurePhaseState(runtime, 'Review', true);
  }
  const latest = await waitForSystemScoring(runtime, createdSubmissions);
  const completedChallenge = await waitForAutopilotCompletion(runtime);

  logStep('Full Marathon Match test completed', {
    challengeId: runtime.challengeId,
    submissions: createdSubmissions.length,
    latestSystemSubmissions: latest.length,
    status: completedChallenge?.status ?? 'autopilot-completion-not-waited',
  });
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
