package com.topcoder.runner;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.topcoder.marathon.MarathonController;
import com.topcoder.marathon.MarathonTestResult;
import com.topcoder.scorer.models.ScorerConfig;
import com.topcoder.scorer.models.ScoringResult;
import com.topcoder.scorer.services.SubmissionService;
import java.io.BufferedWriter;
import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.management.ManagementFactory;
import java.net.URL;
import java.net.URLClassLoader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.GroupPrincipal;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.UserPrincipal;
import java.nio.file.attribute.UserPrincipalLookupService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.apache.http.HttpEntity;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.entity.ContentType;
import org.apache.http.entity.StringEntity;
import org.apache.http.entity.mime.MultipartEntityBuilder;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.util.EntityUtils;

/**
 * ECS entrypoint that fetches marathon match config and tester artifacts from API,
 * runs tester execution, uploads artifacts, and reports results back to the
 * marathon-match API for TypeScript-side review processing.
 */
public class EcsRunnerMain {
    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final int HTTP_BODY_PREVIEW_LIMIT = 8000;
    private static final int ARTIFACT_LOG_PREVIEW_LIMIT = 120000;
    private static final int CHILD_OUTPUT_TAIL_LIMIT = 4000;
    private static final String ISOLATED_TESTER_CHILD_MODE = "--isolated-tester-run";
    private static final String ISOLATED_TESTER_RESULT_MARKER =
        "__MM_ISOLATED_TESTER_RESULT__:";
    private static final String ISOLATED_TESTER_PROGRESS_MARKER =
        "__MM_ISOLATED_TESTER_PROGRESS__:";
    private static final String ISOLATION_WRAPPER_PATH = "/usr/local/bin/mm-net-isolate";
    private static final String ISOLATED_EXECUTION_USER = "runner";
    private static final String ISOLATED_EXECUTION_GROUP = "runner";
    private static final String TEST_STATUS_IN_PROGRESS = "IN PROGRESS";
    private static final String TEST_STATUS_SUCCESS = "SUCCESS";
    private static final String TEST_STATUS_FAILED = "FAILED";
    private static final int DEFAULT_TEST_TIMEOUT_MS = 10000;
    private static final int DEFAULT_COMPILE_TIMEOUT_MS = 30000;
    private static final String GENERIC_SOLUTION_BASE_NAME = "Solution";
    private static final List<String> SUPPORTED_SOURCE_EXTENSIONS = Arrays.asList(
        ".cpp",
        ".java",
        ".py",
        ".cs",
        ".cs_net10",
        ".cs_net7",
        ".rs"
    );
    private static final Pattern JAVA_PACKAGE_PATTERN = Pattern.compile(
        "(?m)^\\s*package\\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)\\s*;"
    );
    private static final Pattern JAVA_PUBLIC_CLASS_PATTERN = Pattern.compile(
        "\\bpublic\\s+(?:final\\s+|abstract\\s+)?class\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\b"
    );
    private static final Pattern JAVA_CLASS_PATTERN = Pattern.compile(
        "\\bclass\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\b"
    );
    private static final Pattern MEMBER_ARTIFACT_JSON_SEED_PATTERN = Pattern.compile(
        "(?i)(\"(?:seed|startSeed|endSeed|phaseStartSeed)\"\\s*:\\s*\"?)\\d+(\"?)"
    );
    private static final Pattern MEMBER_ARTIFACT_KEY_VALUE_SEED_PATTERN = Pattern.compile(
        "(?i)(\\b(?:seed|startSeed|endSeed|phaseStartSeed)\\s*[=:]\\s*)\\d+"
    );
    private static final Pattern MEMBER_ARTIFACT_COMPLETED_SEED_PATTERN = Pattern.compile(
        "(?i)(\\bcompleted\\s+seed\\s+)\\d+"
    );
    private static final Pattern MEMBER_ARTIFACT_TEST_CASE_SEED_PATTERN = Pattern.compile(
        "(?i)(\\btest\\s*case\\s*#)\\d+"
    );

    private static String logChallengeId = "<unset>";
    private static String logSubmissionId = "<unset>";
    private static String logTestPhase = "<unset>";
    private static double lastReportedProgress = 0.0;
    private static int lastReportedCompletedTests = 0;
    private static int lastReportedTotalTests = 0;
    private static int lastReportedFailedTests = 0;

    /**
     * Executes the ECS runner workflow end-to-end using environment-provided IDs and token.
     * @param args Unused CLI arguments. Runtime configuration is provided through env vars.
     */
    public static void main(String[] args) {
        if (isIsolatedTesterChildMode(args)) {
            System.exit(runIsolatedTesterChild(args));
        }

        int exitCode = 2;
        Path submissionDir = null;
        Path testerJarPath = null;
        String challengeId = "<missing>";
        String submissionId = "<missing>";
        String testPhase = "provisional";
        String reviewId = null;
        String accessToken = null;
        String marathonMatchBaseUrl = null;
        String reviewTypeId = null;
        String scorecardId = null;
        String submissionApiUrl = null;

        try {
            challengeId = getRequiredEnv("TESTER_CONFIG_ID");
            submissionId = getRequiredEnv("SUBMISSION_ID");
            accessToken = getRequiredEnv("ACCESS_TOKEN");
            boolean debugLogAccessToken = isTruthyEnv("DEBUG_LOG_ACCESS_TOKEN");
            boolean debugLogFullAccessToken = isTruthyEnv("DEBUG_LOG_FULL_ACCESS_TOKEN");
            marathonMatchBaseUrl = buildMarathonMatchBaseUrl(
                getRequiredEnv("MARATHON_MATCH_API_URL")
            );
            reviewTypeId = getRequiredEnv("REVIEW_TYPE_ID");
            reviewId = getOptionalEnv("REVIEW_ID", "");
            if (reviewId != null && reviewId.isEmpty()) {
                reviewId = null;
            }
            testPhase = normalizeTestPhase(getOptionalEnv("TEST_PHASE", "provisional"));
            long phaseStartSeed = getOptionalLongEnv("PHASE_START_SEED", 0L);
            int phaseNumberOfTests = getOptionalIntEnv("PHASE_NUMBER_OF_TESTS", 0);
            setLogContext(challengeId, submissionId, testPhase);

            logInfo(
                "bootstrap",
                "Starting ECS runner workflow with challengeId="
                    + challengeId
                    + ", submissionId="
                    + submissionId
                    + ", phase="
                    + testPhase
                    + ", marathonMatchBaseUrl="
                    + marathonMatchBaseUrl
                    + ", reviewTypeId="
                    + reviewTypeId
                    + ", phaseStartSeed="
                    + phaseStartSeed
                    + ", phaseNumberOfTests="
                    + phaseNumberOfTests
            );

            if (debugLogAccessToken) {
                logAccessTokenDebug(accessToken, debugLogFullAccessToken);
            }

            try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
                logInfo(
                    "api.fetch-config",
                    "Requesting challenge config for challengeId=" + challengeId
                );
                MarathonMatchConfigResponse config = fetchJson(
                    httpClient,
                    marathonMatchBaseUrl + "/challenge/" + challengeId,
                    accessToken,
                    MarathonMatchConfigResponse.class
                );
                submissionApiUrl = config.getSubmissionApiUrl();
                logInfo(
                    "api.fetch-config",
                    "Loaded challenge config id="
                        + config.getId()
                        + ", challengeId="
                        + config.getChallengeIdOrId()
                        + ", testerId="
                        + config.getTesterId()
                        + ", submissionApiUrl="
                        + config.getSubmissionApiUrl()
                        + ", reviewScorecardId="
                        + config.getReviewScorecardId()
                        + ", testTimeout="
                        + config.getTestTimeout()
                        + ", compileTimeout="
                        + config.getCompileTimeout()
                );

                logInfo(
                    "api.fetch-tester-jar",
                    "Downloading tester jar for challengeId=" + challengeId
                );
                byte[] testerJarBytes = fetchBinary(
                    httpClient,
                    marathonMatchBaseUrl + "/challenge/" + challengeId + "/tester-jar",
                    accessToken
                );
                logInfo(
                    "api.fetch-tester-jar",
                    "Downloaded tester jar bytes=" + testerJarBytes.length
                );

                testerJarPath = writeTesterJar(challengeId, testerJarBytes);
                logInfo("filesystem", "Tester jar written to " + testerJarPath);

                logInfo(
                    "api.fetch-tester-metadata",
                    "Requesting tester metadata for testerId=" + config.getTesterId()
                );
                TesterResponse tester = fetchJson(
                    httpClient,
                    marathonMatchBaseUrl + "/testers/" + config.getTesterId(),
                    accessToken,
                    TesterResponse.class
                );
                logInfo(
                    "api.fetch-tester-metadata",
                    "Loaded tester metadata id="
                        + tester.getId()
                        + ", name="
                        + tester.getName()
                        + ", className="
                        + tester.getClassName()
                        + ", compilationStatus="
                        + tester.getCompilationStatus()
                );

                submissionDir = Paths.get("/tmp/submission-" + submissionId);
                SubmissionService submissionService = new SubmissionService(
                    config.getSubmissionApiUrl(),
                    accessToken
                );
                logInfo(
                    "api.download-submission",
                    "Downloading submissionId="
                        + submissionId
                        + " to "
                        + submissionDir
                        + " via "
                        + config.getSubmissionApiUrl()
                );
                submissionService.downloadSubmission(submissionId, submissionDir.toString());
                logInfo("api.download-submission", "Submission download and extraction complete");
                logDirectorySnapshot(submissionDir, 100);

                ScorerConfig scorerConfig = buildScorerConfig(
                    config,
                    tester,
                    reviewTypeId,
                    phaseStartSeed,
                    phaseNumberOfTests
                );
                logScorerConfig(scorerConfig);
                scorecardId = scorerConfig.getScoreCardId();

                if (isProgressTrackedPhase(testPhase)) {
                    postScoringProgressSafely(
                        httpClient,
                        marathonMatchBaseUrl,
                        accessToken,
                        new ScoringProgressRequest(
                            challengeId,
                            submissionId,
                            testPhase,
                            reviewTypeId,
                            reviewId,
                            scorecardId,
                            0.0,
                            TEST_STATUS_IN_PROGRESS,
                            0,
                            resolvePositiveInt(scorerConfig.getNumberOfTests(), 1),
                            0,
                            "Scoring task started",
                            buildProgressMetadata(testPhase, reviewTypeId)
                        )
                    );
                }

                logInfo(
                    "tester.isolated",
                    "Preparing isolated execution for tester class "
                        + tester.getClassName()
                        + " with submissionDir="
                        + submissionDir
                );
                prepareIsolatedExecutionInputs(submissionDir, testerJarPath);
                TesterExecutionResult testerExecution;
                try {
                    testerExecution = runTesterInIsolation(
                        challengeId,
                        submissionId,
                        testPhase,
                        tester.getClassName(),
                        submissionDir,
                        scorerConfig,
                        testerJarPath,
                        httpClient,
                        marathonMatchBaseUrl,
                        accessToken,
                        reviewTypeId,
                        reviewId,
                        scorecardId
                    );
                } finally {
                    killLingeringIsolatedProcesses();
                }
                logInfo(
                    "tester.invoke",
                    "Tester completed with aggregate score=" + testerExecution.getScore()
                );
                logMap("tester.metadata", testerExecution.getMetadata());
                logIndividualScores(testerExecution.getMetadata());
                logArtifactFilePreview(
                    submissionDir,
                    "execution-" + submissionId + ".log",
                    "tester execution output"
                );
                logArtifactFilePreview(
                    submissionDir,
                    "error-" + submissionId + ".log",
                    "tester error output"
                );

                Map<String, Object> callbackMetadata = buildCallbackMetadata(
                    testerExecution.getMetadata(),
                    testPhase,
                    reviewTypeId
                );
                Map<String, Object> callbackCurrentReview = sanitizeMemberVisibleReview(
                    testerExecution.getCurrentReview()
                );
                List<Map<String, Object>> callbackImpactedReviews =
                    sanitizeMemberVisibleReviews(testerExecution.getImpactedReviews());
                logCurrentAndImpactedReviews(
                    callbackCurrentReview,
                    callbackImpactedReviews
                );
                logMap("callback.metadata", callbackMetadata);
                writeInternalReviewArtifact(
                    submissionDir,
                    submissionId,
                    testPhase,
                    reviewTypeId,
                    scorerConfig.getScoreCardId(),
                    testerExecution,
                    callbackMetadata
                );

                logInfo("artifacts.upload", "Uploading submission artifacts");
                uploadArtifacts(
                    httpClient,
                    config.getSubmissionApiUrl(),
                    accessToken,
                    submissionId,
                    testPhase,
                    submissionDir
                );
                logInfo("artifacts.upload", "Artifact upload completed");

                ScoringCallbackRequest callbackRequest = new ScoringCallbackRequest(
                    challengeId,
                    submissionId,
                    testerExecution.getScore(),
                    testPhase,
                    reviewTypeId,
                    reviewId,
                    scorerConfig.getScoreCardId(),
                    callbackMetadata,
                    callbackCurrentReview,
                    callbackImpactedReviews
                );
                logInfo(
                    "api.callback",
                    "Posting scoring callback for submissionId="
                        + submissionId
                        + ", score="
                        + testerExecution.getScore()
                        + ", testPhase="
                        + testPhase
                );
                logInfo(
                    "api.callback",
                    "Scoring callback payload preview: "
                        + toJsonPreview(callbackRequest, HTTP_BODY_PREVIEW_LIMIT)
                );

                postScoringCallback(
                    httpClient,
                    marathonMatchBaseUrl,
                    accessToken,
                    callbackRequest
                );
                logInfo("api.callback", "Scoring callback completed successfully");

                ScoringResult result = new ScoringResult(testerExecution.getScore(), "completed");
                String resultPayload = OBJECT_MAPPER.writeValueAsString(result);
                logInfo("result", "Runner result payload: " + resultPayload);
                System.out.println(resultPayload);
                exitCode = 0;
            }
        } catch (Exception error) {
            logError(
                "runner.failure",
                "Runner failed with error: " + error.getMessage(),
                error
            );
            writeFailureArtifactLog(submissionDir, submissionId, error);
            uploadFailureArtifactsSafely(
                submissionApiUrl,
                accessToken,
                submissionId,
                testPhase,
                submissionDir
            );
            postFailureProgressSafely(
                challengeId,
                submissionId,
                testPhase,
                reviewId,
                accessToken,
                marathonMatchBaseUrl,
                reviewTypeId,
                scorecardId,
                error.getMessage()
            );
            error.printStackTrace();
        } finally {
            setLogContext(challengeId, submissionId, testPhase);
            logInfo(
                "cleanup",
                "Cleaning up temporary paths submissionDir="
                    + (submissionDir == null ? "<none>" : submissionDir)
                    + ", testerJarPath="
                    + (testerJarPath == null ? "<none>" : testerJarPath)
            );
            deletePathRecursively(submissionDir);
            deletePathRecursively(testerJarPath);
            logInfo("exit", "Exiting runner with code " + exitCode);
            System.exit(exitCode);
        }
    }

    /**
     * Detects the internal child mode used for isolated tester execution.
     */
    private static boolean isIsolatedTesterChildMode(String[] args) {
        return args != null
            && args.length > 0
            && ISOLATED_TESTER_CHILD_MODE.equals(args[0]);
    }

    /**
     * Executes the tester inside a sandboxed child JVM and emits the structured
     * result back to the trusted parent process over stdout.
     */
    private static int runIsolatedTesterChild(String[] args) {
        try {
            if (args.length != 8) {
                throw new IllegalArgumentException(
                    "Isolated tester child mode expects 7 arguments."
                );
            }

            String challengeId = args[1];
            String submissionId = args[2];
            String testPhase = normalizeTestPhase(args[3]);
            String testerClassName = args[4];
            String submissionDir = args[5];
            Path testerJarPath = Paths.get(args[6]);
            Path scorerConfigPath = Paths.get(args[7]);

            setLogContext(challengeId, submissionId, testPhase);
            logInfo(
                "tester.isolated",
                "Running isolated tester child for testerClass=" + testerClassName
            );

            ScorerConfig scorerConfig = OBJECT_MAPPER.readValue(
                scorerConfigPath.toFile(),
                ScorerConfig.class
            );
            logScorerConfig(scorerConfig);

            TesterExecutionResult testerExecution = runTester(
                testerClassName,
                submissionDir,
                scorerConfig,
                testerJarPath
            );
            String serializedResult = OBJECT_MAPPER.writeValueAsString(
                testerExecution.toSerializableMap()
            );
            String encodedResult = Base64
                .getEncoder()
                .encodeToString(serializedResult.getBytes(StandardCharsets.UTF_8));
            System.out.println(ISOLATED_TESTER_RESULT_MARKER + encodedResult);
            return 0;
        } catch (Exception error) {
            logError(
                "tester.isolated",
                "Isolated tester child failed: " + error.getMessage(),
                error
            );
            return 1;
        }
    }

    /**
     * Prepares extracted submission/tester inputs so the isolated runner user can
     * compile, execute, and write artifacts without inheriting trusted env state.
     */
    private static void prepareIsolatedExecutionInputs(
        Path submissionDir,
        Path testerJarPath
    ) throws Exception {
        requireRootParentProcess();
        setPathOwnerRecursively(
            submissionDir,
            ISOLATED_EXECUTION_USER,
            ISOLATED_EXECUTION_GROUP
        );
        setPathOwnerRecursively(
            testerJarPath,
            ISOLATED_EXECUTION_USER,
            ISOLATED_EXECUTION_GROUP
        );
    }

    /**
     * Runs tester execution in a dedicated child JVM that has a scrubbed
     * environment and socket restrictions enforced by the native isolation wrapper.
     */
    @SuppressWarnings("unchecked")
    private static TesterExecutionResult runTesterInIsolation(
        String challengeId,
        String submissionId,
        String testPhase,
        String testerClassName,
        Path submissionDir,
        ScorerConfig scorerConfig,
        Path testerJarPath,
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        String accessToken,
        String reviewTypeId,
        String reviewId,
        String scorecardId
    ) throws Exception {
        Path scorerConfigPath = null;
        try {
            scorerConfigPath = Files.createTempFile("mm-isolated-scorer-", ".json");
            OBJECT_MAPPER.writeValue(scorerConfigPath.toFile(), scorerConfig);
            setPathOwnerRecursively(
                scorerConfigPath,
                ISOLATED_EXECUTION_USER,
                ISOLATED_EXECUTION_GROUP
            );

            List<String> command = buildIsolatedTesterCommand(
                challengeId,
                submissionId,
                testPhase,
                testerClassName,
                submissionDir,
                testerJarPath,
                scorerConfigPath
            );
            logInfo(
                "tester.isolated",
                "Launching isolated tester JVM: " + renderCommandForLog(command)
            );

            Path artifactsDir = ensureArtifactsDir(submissionDir);
            Path executionLogPath = artifactsDir.resolve(
                "execution-" + submissionId + ".log"
            );
            appendText(
                executionLogPath,
                "Launching isolated tester JVM: " + renderCommandForLog(command) + "\n"
            );

            ProcessBuilder processBuilder = new ProcessBuilder(command);
            processBuilder.redirectErrorStream(true);
            Process process = processBuilder.start();

            String encodedResult = null;
            StringBuilder childOutputTail = new StringBuilder();
            try (
                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(
                        process.getInputStream(),
                        StandardCharsets.UTF_8
                    )
                )
            ) {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (line.startsWith(ISOLATED_TESTER_RESULT_MARKER)) {
                        encodedResult = line.substring(
                            ISOLATED_TESTER_RESULT_MARKER.length()
                        );
                    } else if (line.startsWith(ISOLATED_TESTER_PROGRESS_MARKER)) {
                        IsolatedProgressUpdate progressUpdate =
                            parseIsolatedProgressUpdate(line);
                        if (progressUpdate != null && isProgressTrackedPhase(testPhase)) {
                            postScoringProgressSafely(
                                httpClient,
                                marathonMatchBaseUrl,
                                accessToken,
                                new ScoringProgressRequest(
                                    challengeId,
                                    submissionId,
                                    testPhase,
                                    reviewTypeId,
                                    reviewId,
                                    scorecardId,
                                    progressUpdate.getProgress(),
                                    progressUpdate.getStatus(),
                                    progressUpdate.getCompletedTests(),
                                    progressUpdate.getTotalTests(),
                                    progressUpdate.getFailedTests(),
                                    progressUpdate.getMessage(),
                                    buildProgressMetadata(testPhase, reviewTypeId)
                                )
                            );
                        }
                    } else {
                        String publicLine = redactSeedValuesForMemberArtifacts(line);
                        System.out.println(publicLine);
                        appendText(executionLogPath, publicLine + "\n");
                        appendBounded(
                            childOutputTail,
                            publicLine + "\n",
                            CHILD_OUTPUT_TAIL_LIMIT
                        );
                    }
                }
            }

            int exitCode = process.waitFor();
            if (exitCode != 0) {
                String message = "Isolated tester JVM exited with code " + exitCode + ".";
                String outputTail = childOutputTail.toString().trim();
                if (!outputTail.isEmpty()) {
                    message += " Child output tail: "
                        + truncate(outputTail, CHILD_OUTPUT_TAIL_LIMIT);
                }
                appendText(
                    artifactsDir.resolve("error-" + submissionId + ".log"),
                    message + "\n"
                );
                throw new RuntimeException(
                    message
                );
            }

            if (encodedResult == null || encodedResult.trim().isEmpty()) {
                String message = "Isolated tester JVM did not return a structured result.";
                String outputTail = childOutputTail.toString().trim();
                if (!outputTail.isEmpty()) {
                    message += " Child output tail: "
                        + truncate(outputTail, CHILD_OUTPUT_TAIL_LIMIT);
                }
                appendText(
                    artifactsDir.resolve("error-" + submissionId + ".log"),
                    message + "\n"
                );
                throw new RuntimeException(
                    message
                );
            }

            String serializedResult = new String(
                Base64.getDecoder().decode(encodedResult),
                StandardCharsets.UTF_8
            );
            Map<String, Object> resultPayload = OBJECT_MAPPER.readValue(
                serializedResult,
                Map.class
            );
            logInfo(
                "tester.isolated",
                "Received structured tester result with keys="
                    + resultPayload.keySet()
            );
            return parseTesterExecutionResult(resultPayload, testerClassName);
        } finally {
            deletePathRecursively(scorerConfigPath);
        }
    }

    /**
     * Ensures the runner artifact directory exists for the current submission.
     *
     * <p>The isolated child normally creates this directory inside the selected
     * workspace, but parent-side failure handling also needs a deterministic
     * place to write diagnostics when the child exits early.
     *
     * @param submissionDir Extracted submission directory.
     * @return Path to the `artifacts` directory.
     * @throws Exception When the diagnostics directory cannot be created or ownership cannot be adjusted.
     */
    private static Path ensureArtifactsDir(Path submissionDir) throws Exception {
        if (submissionDir == null) {
            throw new IOException("submissionDir is not available for artifact logging.");
        }

        Path artifactBaseDir = resolveArtifactBaseDir(submissionDir);
        if (artifactBaseDir == null) {
            artifactBaseDir = resolveWorkspaceRoot(submissionDir);
        }

        Path artifactsDir = artifactBaseDir.resolve("artifacts");
        Files.createDirectories(artifactsDir.resolve("public"));
        Files.createDirectories(artifactsDir.resolve("private"));
        if ("root".equals(System.getProperty("user.name", ""))) {
            setPathOwnerRecursively(
                artifactsDir,
                ISOLATED_EXECUTION_USER,
                ISOLATED_EXECUTION_GROUP
            );
        }
        return artifactsDir;
    }

    /**
     * Appends text to a bounded StringBuilder, retaining only the most recent
     * characters. This keeps failure progress messages concise while preserving
     * the full child output in artifact logs.
     *
     * @param target Buffer holding the current tail.
     * @param text Text to append.
     * @param maxChars Maximum retained character count.
     */
    private static void appendBounded(StringBuilder target, String text, int maxChars) {
        if (target == null || text == null || maxChars <= 0) {
            return;
        }

        target.append(text);
        if (target.length() > maxChars) {
            target.delete(0, target.length() - maxChars);
        }
    }

    /**
     * Writes parent-side failure diagnostics into the public artifact log area.
     *
     * @param submissionDir Extracted submission directory.
     * @param submissionId Submission ID used in artifact filenames.
     * @param error Failure to record.
     */
    private static void writeFailureArtifactLog(
        Path submissionDir,
        String submissionId,
        Throwable error
    ) {
        if (submissionDir == null || isBlank(submissionId) || "<missing>".equals(submissionId)) {
            return;
        }

        try {
            Path artifactsDir = ensureArtifactsDir(submissionDir);
            Path errorLog = artifactsDir.resolve("error-" + submissionId + ".log");
            String message = error == null
                ? "Runner failed with an unknown error."
                : error.getMessage();
            appendText(
                errorLog,
                "["
                    + Instant.now().toString()
                    + "] Runner failure: "
                    + safeLogValue(message)
                    + "\n"
                    + stackTraceToString(error)
                    + "\n"
            );
        } catch (Exception logError) {
            logWarn(
                "artifacts.failure-log",
                "Unable to write failure artifact log: " + logError.getMessage()
            );
        }
    }

    /**
     * Uploads any artifacts produced before a runner failure.
     *
     * @param submissionApiUrl Submission API base URL used for artifact uploads.
     * @param accessToken Bearer token.
     * @param submissionId Submission ID.
     * @param testPhase Scoring phase.
     * @param submissionDir Extracted submission directory.
     */
    private static void uploadFailureArtifactsSafely(
        String submissionApiUrl,
        String accessToken,
        String submissionId,
        String testPhase,
        Path submissionDir
    ) {
        if (
            isBlank(submissionApiUrl)
                || isBlank(accessToken)
                || isBlank(submissionId)
                || "<missing>".equals(submissionId)
                || submissionDir == null
        ) {
            return;
        }

        try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
            logInfo("artifacts.upload", "Uploading failure artifacts");
            uploadArtifacts(
                httpClient,
                submissionApiUrl,
                accessToken,
                submissionId,
                testPhase,
                submissionDir
            );
            logInfo("artifacts.upload", "Failure artifact upload completed");
        } catch (Exception uploadError) {
            logWarn(
                "artifacts.upload",
                "Unable to upload failure artifacts: " + uploadError.getMessage()
            );
        }
    }

    /**
     * Renders a Throwable stack trace for artifact logs.
     *
     * @param error Throwable to render.
     * @return Stack trace text, or an empty string when no Throwable is supplied.
     */
    private static String stackTraceToString(Throwable error) {
        if (error == null) {
            return "";
        }

        java.io.StringWriter stringWriter = new java.io.StringWriter();
        java.io.PrintWriter printWriter = new java.io.PrintWriter(stringWriter);
        error.printStackTrace(printWriter);
        printWriter.flush();
        return stringWriter.toString();
    }

    /**
     * Parses one base64-encoded progress marker emitted by the isolated tester child.
     *
     * @param line Raw stdout line from the child JVM.
     * @return Progress update payload, or {@code null} when decoding fails.
     */
    private static IsolatedProgressUpdate parseIsolatedProgressUpdate(String line) {
        try {
            String encodedProgress = line.substring(
                ISOLATED_TESTER_PROGRESS_MARKER.length()
            );
            String serializedProgress = new String(
                Base64.getDecoder().decode(encodedProgress),
                StandardCharsets.UTF_8
            );
            return OBJECT_MAPPER.readValue(
                serializedProgress,
                IsolatedProgressUpdate.class
            );
        } catch (Exception error) {
            logWarn(
                "tester.progress",
                "Unable to parse isolated tester progress marker: " + error.getMessage()
            );
            return null;
        }
    }

    /**
     * Builds the isolated child command using the current Java runtime and shaded
     * runner JAR so parent and child stay on the same build artifact.
     */
    private static List<String> buildIsolatedTesterCommand(
        String challengeId,
        String submissionId,
        String testPhase,
        String testerClassName,
        Path submissionDir,
        Path testerJarPath,
        Path scorerConfigPath
    ) throws Exception {
        List<String> command = new ArrayList<String>();
        command.add(ISOLATION_WRAPPER_PATH);
        command.add(getCurrentJavaBinaryPath());
        command.addAll(getIsolatedChildJvmArguments());
        command.add("-cp");
        command.add(getCurrentRunnerArtifactPath().toString());
        command.add(EcsRunnerMain.class.getName());
        command.add(ISOLATED_TESTER_CHILD_MODE);
        command.add(challengeId);
        command.add(submissionId);
        command.add(normalizeTestPhase(testPhase));
        command.add(testerClassName);
        command.add(submissionDir.toString());
        command.add(testerJarPath.toString());
        command.add(scorerConfigPath.toString());
        return command;
    }

    /**
     * Resolves the Java binary that launched the parent runner.
     */
    private static String getCurrentJavaBinaryPath() {
        return Paths.get(System.getProperty("java.home"), "bin", "java").toString();
    }

    /**
     * Filters the current JVM arguments down to the flags that the isolated child
     * should inherit. Debugging or agent flags are intentionally excluded because
     * they often require sockets, which are blocked for the child process.
     */
    private static List<String> getIsolatedChildJvmArguments() {
        List<String> childArguments = new ArrayList<String>();
        for (String argument : ManagementFactory.getRuntimeMXBean().getInputArguments()) {
            if (
                argument.startsWith("-Xms")
                    || argument.startsWith("-Xmx")
                    || argument.startsWith("-XX:")
                    || argument.startsWith("-D")
            ) {
                childArguments.add(argument);
            }
        }
        return childArguments;
    }

    /**
     * Resolves the shaded runner artifact path used to start this JVM.
     */
    private static Path getCurrentRunnerArtifactPath() throws Exception {
        return Paths.get(
            EcsRunnerMain.class
                .getProtectionDomain()
                .getCodeSource()
                .getLocation()
                .toURI()
        );
    }

    /**
     * Renders command arguments for logs.
     */
    private static String renderCommandForLog(List<String> command) {
        return String.join(" ", command);
    }

    /**
     * Fails fast when the trusted parent process is not running as root. The
     * isolation wrapper relies on a root parent so the child can be demoted to
     * the untrusted runner user and blocked from inspecting parent secrets.
     */
    private static void requireRootParentProcess() {
        String currentUser = System.getProperty("user.name", "");
        if (!"root".equals(currentUser)) {
            throw new IllegalStateException(
                "Runner must start as root so isolated execution can drop to "
                    + ISOLATED_EXECUTION_USER
                    + ". Current user: "
                    + currentUser
            );
        }
    }

    /**
     * Changes ownership recursively so the untrusted runner user can write only
     * to the isolated execution workspace.
     */
    private static void setPathOwnerRecursively(
        Path path,
        String ownerName,
        String groupName
    ) throws Exception {
        if (path == null || !Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }

        UserPrincipalLookupService lookupService = path
            .getFileSystem()
            .getUserPrincipalLookupService();
        UserPrincipal owner = lookupService.lookupPrincipalByName(ownerName);
        GroupPrincipal group = lookupService.lookupPrincipalByGroupName(groupName);

        if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
            try (java.util.stream.Stream<Path> stream = Files.walk(path)) {
                stream.forEach(entry -> applyPathOwnership(entry, owner, group));
            }
            return;
        }

        applyPathOwnership(path, owner, group);
    }

    /**
     * Applies owner/group changes to one filesystem entry.
     */
    private static void applyPathOwnership(
        Path path,
        UserPrincipal owner,
        GroupPrincipal group
    ) {
        try {
            Files.setOwner(path, owner);
            PosixFileAttributeView attributes = Files.getFileAttributeView(
                path,
                PosixFileAttributeView.class,
                LinkOption.NOFOLLOW_LINKS
            );
            if (attributes != null) {
                attributes.setGroup(group);
            }
        } catch (Exception error) {
            throw new RuntimeException(
                "Failed to change owner for " + path + ": " + error.getMessage(),
                error
            );
        }
    }

    /**
     * Kills any remaining runner-owned processes after isolated execution so
     * detached child processes cannot mutate artifacts or linger until task exit.
     */
    private static void killLingeringIsolatedProcesses() {
        try {
            ProcessBuilder processBuilder = new ProcessBuilder(
                "pkill",
                "-KILL",
                "-u",
                ISOLATED_EXECUTION_USER
            );
            processBuilder.redirectErrorStream(true);
            Process process = processBuilder.start();
            String output;
            try (InputStream inputStream = process.getInputStream()) {
                output = new String(readAllBytes(inputStream), StandardCharsets.UTF_8)
                    .trim();
            }

            int exitCode = process.waitFor();
            if (exitCode == 0) {
                logWarn(
                    "tester.isolated",
                    "Killed lingering processes for user "
                        + ISOLATED_EXECUTION_USER
                        + "."
                );
                return;
            }

            if (exitCode == 1) {
                logInfo(
                    "tester.isolated",
                    "No lingering processes found for user "
                        + ISOLATED_EXECUTION_USER
                        + "."
                );
                return;
            }

            logWarn(
                "tester.isolated",
                "pkill exited with code "
                    + exitCode
                    + (output.isEmpty() ? "" : ", output=" + output)
            );
        } catch (Exception error) {
            logWarn(
                "tester.isolated",
                "Failed to clean lingering isolated processes: "
                    + error.getMessage()
            );
        }
    }

    /**
     * Sets log context values printed on every runner log line.
     * @param challengeId Challenge ID currently being processed.
     * @param submissionId Submission ID currently being processed.
     * @param testPhase Active scorer phase.
     */
    private static void setLogContext(
        String challengeId,
        String submissionId,
        String testPhase
    ) {
        logChallengeId = safeLogValue(challengeId);
        logSubmissionId = safeLogValue(submissionId);
        logTestPhase = safeLogValue(testPhase);
    }

    /**
     * Logs an informational message with submission context.
     */
    private static void logInfo(String step, String message) {
        log("INFO", step, message, null);
    }

    /**
     * Logs a warning message with submission context.
     */
    private static void logWarn(String step, String message) {
        log("WARN", step, message, null);
    }

    /**
     * Logs an error message with submission context and optional exception details.
     */
    private static void logError(String step, String message, Throwable error) {
        log("ERROR", step, message, error);
    }

    /**
     * Emits a structured log line.
     */
    private static void log(
        String level,
        String step,
        String message,
        Throwable error
    ) {
        StringBuilder builder = new StringBuilder();
        builder
            .append("[")
            .append(Instant.now().toString())
            .append("] [")
            .append(level)
            .append("] [runner] [challengeId=")
            .append(logChallengeId)
            .append("] [submissionId=")
            .append(logSubmissionId)
            .append("] [testPhase=")
            .append(logTestPhase)
            .append("] [")
            .append(safeLogValue(step))
            .append("] ")
            .append(safeLogValue(message));

        String rendered = builder.toString();
        if ("ERROR".equals(level)) {
            System.err.println(rendered);
            if (error != null) {
                error.printStackTrace(System.err);
            }
            return;
        }

        System.out.println(rendered);
    }

    /**
     * Logs scorer configuration values used for tester execution.
     * @param scorerConfig Scorer config used by generic or custom tester execution.
     */
    private static void logScorerConfig(ScorerConfig scorerConfig) {
        if (scorerConfig == null) {
            logWarn("config.scorer", "Scorer config is null.");
            return;
        }

        logInfo(
            "config.scorer",
            "ScorerConfig {"
                + "name="
                + scorerConfig.getName()
                + ", testerClass="
                + scorerConfig.getTesterClass()
                + ", scoreCardId="
                + scorerConfig.getScoreCardId()
                + ", reviewerId="
                + scorerConfig.getReviewerId()
                + ", typeId="
                + scorerConfig.getTypeId()
                + ", startSeed=<redacted>"
                + ", numberOfTests="
                + scorerConfig.getNumberOfTests()
                + ", timeLimit="
                + scorerConfig.getTimeLimit()
                + ", timeout="
                + scorerConfig.getTimeout()
                + ", compileTimeout="
                + scorerConfig.getCompileTimeout()
                + "}"
        );
    }

    /**
     * Logs a JSON preview for map-like payloads.
     * @param step Log step/context label.
     * @param payload Map payload to render.
     */
    private static void logMap(String step, Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            logInfo(step, "<empty>");
            return;
        }

        logInfo(step, toJsonPreview(payload, HTTP_BODY_PREVIEW_LIMIT));
    }

    /**
     * Logs per-test score entries when tester metadata includes `testScores`.
     * @param metadata Tester metadata map.
     */
    @SuppressWarnings("unchecked")
    private static void logIndividualScores(Map<String, Object> metadata) {
        if (metadata == null || metadata.isEmpty()) {
            logWarn("scores.individual", "Tester metadata is empty; no per-test scores found.");
            return;
        }

        Object testScores = metadata.get("testScores");
        if (!(testScores instanceof List)) {
            logWarn(
                "scores.individual",
                "Tester metadata does not include list field `testScores`."
            );
            return;
        }

        List<Object> scoreList = (List<Object>) testScores;
        if (scoreList.isEmpty()) {
            logWarn("scores.individual", "`testScores` is present but empty.");
            return;
        }

        for (int index = 0; index < scoreList.size(); index++) {
            Object scoreEntry = scoreList.get(index);
            logInfo(
                "scores.individual",
                "test[" + index + "] = " + toJsonPreview(scoreEntry, HTTP_BODY_PREVIEW_LIMIT)
            );
        }
    }

    /**
     * Logs callback review payload context returned by trusted tester code.
     * @param currentReview Current review payload returned by the tester.
     * @param impactedReviews Impacted review payloads returned by the tester.
     */
    private static void logCurrentAndImpactedReviews(
        Map<String, Object> currentReview,
        List<Map<String, Object>> impactedReviews
    ) {
        if (currentReview == null || currentReview.isEmpty()) {
            logInfo("callback.currentReview", "<none>");
        } else {
            logInfo(
                "callback.currentReview",
                toJsonPreview(currentReview, HTTP_BODY_PREVIEW_LIMIT)
            );
        }

        if (impactedReviews == null || impactedReviews.isEmpty()) {
            logInfo("callback.impactedReviews", "<none>");
            return;
        }

        for (int index = 0; index < impactedReviews.size(); index++) {
            Map<String, Object> review = impactedReviews.get(index);
            logInfo(
                "callback.impactedReviews",
                "review["
                    + index
                    + "] = "
                    + toJsonPreview(review, HTTP_BODY_PREVIEW_LIMIT)
            );
        }
    }

    /**
     * Logs a snapshot of extracted submission files for troubleshooting.
     * @param directoryPath Directory to inspect.
     * @param maxEntries Maximum number of files to print.
     */
    private static void logDirectorySnapshot(Path directoryPath, int maxEntries) {
        if (directoryPath == null) {
            logWarn("filesystem.snapshot", "Directory path is null.");
            return;
        }

        if (!Files.exists(directoryPath)) {
            logWarn("filesystem.snapshot", "Directory does not exist: " + directoryPath);
            return;
        }

        List<Path> collected = new ArrayList<Path>();
        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            stream
                .filter(path -> Files.isRegularFile(path))
                .limit(maxEntries)
                .forEach(collected::add);
        } catch (Exception error) {
            logError(
                "filesystem.snapshot",
                "Failed to list files under " + directoryPath,
                error
            );
            return;
        }

        logInfo(
            "filesystem.snapshot",
            "Found "
                + collected.size()
                + " files (showing up to "
                + maxEntries
                + ") under "
                + directoryPath
        );
        for (Path path : collected) {
            try {
                long sizeBytes = Files.size(path);
                logInfo(
                    "filesystem.snapshot",
                    directoryPath.relativize(path).toString() + " (" + sizeBytes + " bytes)"
                );
            } catch (Exception sizeError) {
                logWarn(
                    "filesystem.snapshot",
                    directoryPath.relativize(path).toString() + " (size unavailable)"
                );
            }
        }
    }

    /**
     * Prints artifact log file content preview when available.
     * @param submissionDir Submission workspace root.
     * @param relativePath Relative path inside `artifacts/`.
     * @param description Human-readable description shown in logs.
     */
    private static void logArtifactFilePreview(
        Path submissionDir,
        String relativePath,
        String description
    ) {
        Path artifactPath = findArtifactFile(submissionDir, relativePath);
        if (artifactPath == null || !Files.isRegularFile(artifactPath)) {
            logInfo(
                "artifacts.preview",
                "No " + description + " file found at artifacts/" + relativePath
            );
            return;
        }

        try {
            String content = new String(Files.readAllBytes(artifactPath), StandardCharsets.UTF_8);
            logInfo(
                "artifacts.preview",
                description
                    + " path="
                    + artifactPath
                    + ", sizeBytes="
                    + Files.size(artifactPath)
                    + ", content=\n"
                    + truncate(content, ARTIFACT_LOG_PREVIEW_LIMIT)
            );
        } catch (Exception error) {
            logError(
                "artifacts.preview",
                "Failed to read " + description + " file at " + artifactPath,
                error
            );
        }
    }

    /**
     * Renders an object as JSON string and truncates long output for logging.
     * @param payload Object to serialize.
     * @param maxLength Maximum output length.
     * @returns JSON (or string fallback) preview.
     */
    private static String toJsonPreview(Object payload, int maxLength) {
        if (payload == null) {
            return "null";
        }

        try {
            return truncate(OBJECT_MAPPER.writeValueAsString(payload), maxLength);
        } catch (Exception ignored) {
            return truncate(String.valueOf(payload), maxLength);
        }
    }

    /**
     * Truncates text while preserving beginning and end segments.
     * @param value Input text.
     * @param maxLength Maximum output length.
     * @returns Truncated text with middle elision when needed.
     */
    private static String truncate(String value, int maxLength) {
        if (value == null) {
            return "";
        }

        if (maxLength <= 0 || value.length() <= maxLength) {
            return value;
        }

        int headLength = Math.max(1, (maxLength - 32) / 2);
        int tailLength = Math.max(1, maxLength - headLength - 32);
        return value.substring(0, headLength)
            + "\n...<truncated "
            + (value.length() - maxLength)
            + " chars>...\n"
            + value.substring(value.length() - tailLength);
    }

    /**
     * Sanitizes potentially null log values.
     * @param value Any value.
     * @returns Safe, trimmed string.
     */
    private static String safeLogValue(Object value) {
        if (value == null) {
            return "<null>";
        }

        String text = String.valueOf(value).trim();
        return text.isEmpty() ? "<empty>" : text;
    }

    /**
     * Redacts obvious seed-bearing log fragments before they are copied into public artifacts.
     *
     * @param value Child process output line.
     * @return Redacted line safe for member-visible execution artifacts.
     */
    private static String redactSeedValuesForMemberArtifacts(String value) {
        if (value == null) {
            return null;
        }

        String redacted = MEMBER_ARTIFACT_JSON_SEED_PATTERN
            .matcher(value)
            .replaceAll("$1<redacted>$2");
        redacted = MEMBER_ARTIFACT_KEY_VALUE_SEED_PATTERN
            .matcher(redacted)
            .replaceAll("$1<redacted>");
        redacted = MEMBER_ARTIFACT_COMPLETED_SEED_PATTERN
            .matcher(redacted)
            .replaceAll("$1<redacted>");
        redacted = MEMBER_ARTIFACT_TEST_CASE_SEED_PATTERN
            .matcher(redacted)
            .replaceAll("$1<redacted>");
        return redacted;
    }

    /**
     * Reads a required environment variable.
     */
    private static String getRequiredEnv(String variableName) {
        String value = System.getenv(variableName);
        if (value == null || value.trim().isEmpty()) {
            throw new IllegalArgumentException(
                "Missing required environment variable: " + variableName
            );
        }
        return value.trim();
    }

    /**
     * Reads an optional environment variable and returns a default when missing.
     */
    private static String getOptionalEnv(String variableName, String defaultValue) {
        String value = System.getenv(variableName);
        if (value == null) {
            return defaultValue;
        }

        String trimmed = value.trim();
        return trimmed.isEmpty() ? defaultValue : trimmed;
    }

    /**
     * Reads an optional integer environment variable and returns a default when missing.
     */
    private static int getOptionalIntEnv(String variableName, int defaultValue) {
        String value = System.getenv(variableName);
        if (value == null || value.trim().isEmpty()) {
            return defaultValue;
        }

        try {
            return Integer.parseInt(value.trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                "Environment variable "
                    + variableName
                    + " must be an integer. Received: "
                    + value
            );
        }
    }

    /**
     * Reads an optional 64-bit integer environment variable and returns a default when missing.
     *
     * @param variableName Environment variable name.
     * @param defaultValue Default value used when the variable is missing or blank.
     * @return Parsed long value or the default value.
     * @throws IllegalArgumentException When the configured value is not a valid Java long.
     */
    private static long getOptionalLongEnv(String variableName, long defaultValue) {
        String value = System.getenv(variableName);
        if (value == null || value.trim().isEmpty()) {
            return defaultValue;
        }

        try {
            return Long.parseLong(value.trim());
        } catch (NumberFormatException error) {
            throw new IllegalArgumentException(
                "Environment variable "
                    + variableName
                    + " must be a 64-bit integer. Received: "
                    + value
            );
        }
    }

    /**
     * Parses boolean-like environment values.
     * @param variableName Environment variable name.
     * @returns True for "1", "true", "yes", or "on" (case-insensitive), otherwise false.
     */
    private static boolean isTruthyEnv(String variableName) {
        String value = getOptionalEnv(variableName, "false");
        String normalized = value.trim().toLowerCase(Locale.US);
        return "1".equals(normalized)
            || "true".equals(normalized)
            || "yes".equals(normalized)
            || "on".equals(normalized);
    }

    /**
     * Emits token debugging information for auth troubleshooting.
     * @param accessToken Access token provided to the ECS runner.
     * @param logFullToken Whether to print the full token value.
     */
    private static void logAccessTokenDebug(String accessToken, boolean logFullToken) {
        logInfo("auth.token", "ACCESS_TOKEN length=" + accessToken.length());
        logInfo(
            "auth.token",
            "ACCESS_TOKEN value=" + (logFullToken ? accessToken : redactToken(accessToken))
        );

        String headerJson = decodeJwtSection(accessToken, 0);
        if (headerJson != null) {
            logInfo("auth.token", "ACCESS_TOKEN header=" + headerJson);
        } else {
            logWarn("auth.token", "ACCESS_TOKEN header=<unavailable>");
        }

        String payloadJson = decodeJwtSection(accessToken, 1);
        if (payloadJson != null) {
            logInfo("auth.token", "ACCESS_TOKEN payload=" + payloadJson);
        } else {
            logWarn("auth.token", "ACCESS_TOKEN payload=<unavailable>");
        }
    }

    /**
     * Produces a partially redacted token string suitable for logs.
     * @param token Raw token value.
     * @returns Token preview with middle characters masked.
     */
    private static String redactToken(String token) {
        if (token == null || token.isEmpty()) {
            return "<empty>";
        }

        if (token.length() <= 24) {
            return "<redacted-length-" + token.length() + ">";
        }

        return token.substring(0, 12) + "..." + token.substring(token.length() - 8);
    }

    /**
     * Decodes a JWT section without signature verification.
     * @param token Raw JWT token.
     * @param sectionIndex Section index (0=header, 1=payload).
     * @returns Decoded JSON string or null when token format is invalid.
     */
    private static String decodeJwtSection(String token, int sectionIndex) {
        if (token == null) {
            return null;
        }

        String[] parts = token.split("\\.");
        if (parts.length <= sectionIndex) {
            return null;
        }

        String section = parts[sectionIndex];
        if (section == null || section.isEmpty()) {
            return null;
        }

        try {
            byte[] decoded = Base64.getUrlDecoder().decode(padBase64Url(section));
            return new String(decoded, StandardCharsets.UTF_8);
        } catch (IllegalArgumentException error) {
            return null;
        }
    }

    /**
     * Adds missing base64url padding when needed.
     * @param encodedValue Raw base64url string.
     * @returns Padded base64url string.
     */
    private static String padBase64Url(String encodedValue) {
        int mod = encodedValue.length() % 4;
        if (mod == 0) {
            return encodedValue;
        }
        if (mod == 2) {
            return encodedValue + "==";
        }
        if (mod == 3) {
            return encodedValue + "=";
        }
        return encodedValue + "===";
    }

    /**
     * Removes trailing slashes from a URL.
     */
    private static String normalizeBaseUrl(String baseUrl) {
        String normalized = baseUrl;
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    /**
     * Normalizes to marathon-match API base URL.
     */
    private static String buildMarathonMatchBaseUrl(String marathonMatchApiUrl) {
        String normalized = normalizeBaseUrl(marathonMatchApiUrl);

        if (normalized.endsWith("/v6/marathon-match")) {
            return normalized;
        }
        if (normalized.endsWith("/v6")) {
            return normalized + "/marathon-match";
        }

        return normalized + "/v6/marathon-match";
    }

    /**
     * Normalizes test phase aliases to one of example/provisional/system.
     */
    private static String normalizeTestPhase(String testPhase) {
        String normalized = (
            testPhase == null ? "" : testPhase.trim().toLowerCase(Locale.US)
        );
        if ("example".equals(normalized)) {
            return "example";
        }
        if ("system".equals(normalized) || "final".equals(normalized)) {
            return "system";
        }

        return "provisional";
    }

    /**
     * Determines whether review summation progress should be posted for a phase.
     */
    private static boolean isProgressTrackedPhase(String testPhase) {
        String normalized = normalizeTestPhase(testPhase);
        return "provisional".equals(normalized) || "system".equals(normalized);
    }

    /**
     * Checks whether a string value is null or whitespace-only.
     */
    private static boolean isBlank(String value) {
        return value == null || value.trim().isEmpty();
    }

    /**
     * Performs an authorized HTTP GET and deserializes JSON body to a class.
     */
    private static <T> T fetchJson(
        CloseableHttpClient httpClient,
        String url,
        String accessToken,
        Class<T> responseType
    ) throws Exception {
        logInfo(
            "http.get.json",
            "GET " + url + " (responseType=" + responseType.getSimpleName() + ")"
        );
        String body = executeGetAsString(httpClient, url, accessToken);
        logInfo(
            "http.get.json",
            "Deserializing " + body.length() + " chars from " + url
        );
        return OBJECT_MAPPER.readValue(body, responseType);
    }

    /**
     * Performs an authorized HTTP GET and reads raw binary response.
     */
    private static byte[] fetchBinary(
        CloseableHttpClient httpClient,
        String url,
        String accessToken
    ) throws Exception {
        HttpGet request = new HttpGet(url);
        request.setHeader("Authorization", "Bearer " + accessToken);
        logInfo(
            "http.get.binary",
            "GET " + url + " with Authorization Bearer token"
        );

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            logInfo("http.get.binary", "GET " + url + " returned HTTP " + statusCode);
            if (statusCode < 200 || statusCode >= 300) {
                String responseBody = response.getEntity() == null
                    ? ""
                    : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
                logError(
                    "http.get.binary",
                    "GET "
                        + url
                        + " failed: HTTP "
                        + statusCode
                        + ", body="
                        + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT),
                    null
                );
                throw new RuntimeException(
                    "GET " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }

            if (response.getEntity() == null) {
                logError(
                    "http.get.binary",
                    "GET " + url + " returned empty response body",
                    null
                );
                throw new RuntimeException("GET " + url + " returned empty response body.");
            }

            try (InputStream inputStream = response.getEntity().getContent()) {
                byte[] bytes = readAllBytes(inputStream);
                logInfo(
                    "http.get.binary",
                    "GET " + url + " returned " + bytes.length + " bytes"
                );
                return bytes;
            }
        }
    }

    /**
     * Executes an authorized GET request and returns response body as UTF-8 text.
     */
    private static String executeGetAsString(
        CloseableHttpClient httpClient,
        String url,
        String accessToken
    ) throws Exception {
        HttpGet request = new HttpGet(url);
        request.setHeader("Authorization", "Bearer " + accessToken);
        request.setHeader("Content-Type", "application/json");
        logInfo("http.get", "GET " + url + " (Content-Type: application/json)");

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
            logInfo(
                "http.get",
                "GET "
                    + url
                    + " returned HTTP "
                    + statusCode
                    + ", bodyChars="
                    + responseBody.length()
                    + ", bodyPreview="
                    + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
            );

            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "GET " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }

            return responseBody;
        }
    }

    /**
     * Posts scoring callback payload to marathon-match API.
     */
    private static void postScoringCallback(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        String accessToken,
        ScoringCallbackRequest callbackRequest
    ) throws Exception {
        String url = marathonMatchBaseUrl + "/internal/scoring-results";
        String payload = OBJECT_MAPPER.writeValueAsString(callbackRequest);

        HttpPost request = new HttpPost(url);
        request.setHeader("Authorization", "Bearer " + accessToken);
        request.setHeader("Content-Type", "application/json");
        request.setEntity(new StringEntity(payload, StandardCharsets.UTF_8));
        logInfo(
            "http.post.callback",
            "POST " + url + " payloadChars=" + payload.length()
        );
        logInfo(
            "http.post.callback",
            "POST payload preview: " + truncate(payload, HTTP_BODY_PREVIEW_LIMIT)
        );

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
            logInfo(
                "http.post.callback",
                "POST "
                    + url
                    + " returned HTTP "
                    + statusCode
                    + ", responsePreview="
                    + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
            );

            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "POST " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }
        }
    }

    /**
     * Posts a scoring progress payload to marathon-match API without failing the runner.
     *
     * @param httpClient Trusted parent HTTP client.
     * @param marathonMatchBaseUrl Marathon Match API base URL.
     * @param accessToken Bearer token for the internal API.
     * @param progressRequest Progress payload to persist in review summation metadata.
     */
    private static void postScoringProgressSafely(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        String accessToken,
        ScoringProgressRequest progressRequest
    ) {
        rememberScoringProgress(progressRequest);

        try {
            postScoringProgress(
                httpClient,
                marathonMatchBaseUrl,
                accessToken,
                progressRequest
            );
        } catch (Exception error) {
            logWarn(
                "api.progress",
                "Unable to post scoring progress: " + error.getMessage()
            );
        }
    }

    /**
     * Best-effort failure update used when the runner exits before final callback.
     *
     * @param challengeId Challenge ID.
     * @param submissionId Submission ID.
     * @param testPhase Scoring phase.
     * @param reviewId Optional review ID for system scoring.
     * @param accessToken Bearer token, when bootstrap reached token loading.
     * @param marathonMatchBaseUrl Marathon Match API base URL, when available.
     * @param reviewTypeId Review type ID, when available.
     * @param scorecardId Scorecard ID, when available.
     * @param message Failure message.
     */
    private static void postFailureProgressSafely(
        String challengeId,
        String submissionId,
        String testPhase,
        String reviewId,
        String accessToken,
        String marathonMatchBaseUrl,
        String reviewTypeId,
        String scorecardId,
        String message
    ) {
        if (
            !isProgressTrackedPhase(testPhase)
                || isBlank(accessToken)
                || isBlank(marathonMatchBaseUrl)
                || isBlank(reviewTypeId)
                || isBlank(challengeId)
                || "<missing>".equals(challengeId)
                || isBlank(submissionId)
                || "<missing>".equals(submissionId)
        ) {
            return;
        }

        try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
            postScoringProgressSafely(
                httpClient,
                marathonMatchBaseUrl,
                accessToken,
                new ScoringProgressRequest(
                    challengeId,
                    submissionId,
                    testPhase,
                    reviewTypeId,
                    reviewId,
                    scorecardId,
                    lastReportedProgress,
                    TEST_STATUS_FAILED,
                    lastReportedCompletedTests,
                    lastReportedTotalTests,
                    Math.max(1, lastReportedFailedTests),
                    message,
                    buildProgressMetadata(testPhase, reviewTypeId)
                )
            );
        } catch (Exception error) {
            logWarn(
                "api.progress",
                "Unable to post failure progress: " + error.getMessage()
            );
        }
    }

    /**
     * Posts scoring progress to marathon-match API.
     *
     * @param httpClient Trusted parent HTTP client.
     * @param marathonMatchBaseUrl Marathon Match API base URL.
     * @param accessToken Bearer token for the internal API.
     * @param progressRequest Progress payload to persist in review summation metadata.
     * @throws Exception When the API rejects the progress update.
     */
    private static void postScoringProgress(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        String accessToken,
        ScoringProgressRequest progressRequest
    ) throws Exception {
        String url = marathonMatchBaseUrl + "/internal/scoring-progress";
        String payload = OBJECT_MAPPER.writeValueAsString(progressRequest);

        HttpPost request = new HttpPost(url);
        request.setHeader("Authorization", "Bearer " + accessToken);
        request.setHeader("Content-Type", "application/json");
        request.setEntity(new StringEntity(payload, StandardCharsets.UTF_8));
        logInfo(
            "http.post.progress",
            "POST " + url + " payloadChars=" + payload.length()
        );

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
            logInfo(
                "http.post.progress",
                "POST "
                    + url
                    + " returned HTTP "
                    + statusCode
                    + ", responsePreview="
                    + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
            );

            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "POST " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }
        }
    }

    /**
     * Tracks the most recent progress so failure handling can preserve it.
     *
     * @param progressRequest Progress payload being posted.
     */
    private static void rememberScoringProgress(
        ScoringProgressRequest progressRequest
    ) {
        lastReportedProgress = progressRequest.getProgress();
        lastReportedCompletedTests = progressRequest.getCompletedTests();
        lastReportedTotalTests = progressRequest.getTotalTests();
        lastReportedFailedTests = progressRequest.getFailedTests();
    }

    /**
     * Builds common metadata for progress-only review summation updates.
     *
     * @param testPhase Scoring phase.
     * @param reviewTypeId Review type identifier.
     * @return Metadata map sent with progress updates.
     */
    private static Map<String, Object> buildProgressMetadata(
        String testPhase,
        String reviewTypeId
    ) {
        Map<String, Object> metadata = new LinkedHashMap<String, Object>();
        String normalizedTestPhase = normalizeTestPhase(testPhase);
        if (isProgressTrackedPhase(normalizedTestPhase)) {
            metadata.put("testProcess", normalizedTestPhase);
        }
        metadata.put("testType", normalizedTestPhase);
        metadata.put("reviewTypeId", reviewTypeId);
        return metadata;
    }

    /**
     * Builds callback metadata with enforced testProcess, testType, and reviewTypeId.
     */
    private static Map<String, Object> buildCallbackMetadata(
        Map<String, Object> metadata,
        String testPhase,
        String reviewTypeId
    ) {
        Map<String, Object> safeMetadata = sanitizeMemberVisibleMetadata(metadata);
        Map<String, Object> result = safeMetadata == null
            ? new LinkedHashMap<String, Object>()
            : new LinkedHashMap<String, Object>(safeMetadata);

        String normalizedTestPhase = normalizeTestPhase(testPhase);
        if (isProgressTrackedPhase(normalizedTestPhase)) {
            result.put("testProcess", normalizedTestPhase);
        } else {
            result.remove("testProcess");
        }
        result.put("testType", normalizedTestPhase);
        result.put("reviewTypeId", reviewTypeId);
        return result;
    }

    /**
     * Removes configured seed values from metadata that may be persisted or rendered to members.
     * Per-test entries keep a stable 1-based testcase ordinal so relative scoring still works.
     *
     * @param metadata Metadata returned by tester execution.
     * @return Copy with seed-bearing fields removed or replaced, or {@code null}.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> sanitizeMemberVisibleMetadata(
        Map<String, Object> metadata
    ) {
        if (metadata == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<String, Object>();
        for (Map.Entry<String, Object> entry : metadata.entrySet()) {
            String key = entry.getKey();
            if (isSensitiveSeedMetadataKey(key)) {
                continue;
            }

            Object value = entry.getValue();
            if ("testScores".equals(key) && value instanceof List) {
                result.put(key, sanitizeMemberVisibleScoreEntries((List<?>) value));
            } else if ("relativeScores".equals(key) && value instanceof List) {
                result.put(key, sanitizeMemberVisibleScoreEntries((List<?>) value));
            } else if (value instanceof Map) {
                result.put(
                    key,
                    sanitizeMemberVisibleMetadata((Map<String, Object>) value)
                );
            } else {
                result.put(key, value);
            }
        }

        return result;
    }

    /**
     * Replaces seed-valued score entry identifiers with stable 1-based ordinals.
     *
     * @param scoreEntries Raw `testScores` or `relativeScores` entries.
     * @return Sanitized score entries.
     */
    private static List<Object> sanitizeMemberVisibleScoreEntries(List<?> scoreEntries) {
        List<Object> result = new ArrayList<Object>();
        for (int index = 0; index < scoreEntries.size(); index++) {
            Object rawEntry = scoreEntries.get(index);
            Map<String, Object> safeEntry = new LinkedHashMap<String, Object>();
            if (rawEntry instanceof Map) {
                Map<?, ?> rawMap = (Map<?, ?>) rawEntry;
                for (Map.Entry<?, ?> rawMapEntry : rawMap.entrySet()) {
                    Object rawKey = rawMapEntry.getKey();
                    if (!(rawKey instanceof String)) {
                        continue;
                    }

                    String key = (String) rawKey;
                    if (isSensitiveSeedMetadataKey(key) || "testcase".equals(key)) {
                        continue;
                    }

                    safeEntry.put(key, rawMapEntry.getValue());
                }
            }

            safeEntry.put("testcase", Integer.toString(index + 1));
            result.add(safeEntry);
        }

        return result;
    }

    /**
     * Removes seed values from review metadata before it is sent to API callbacks.
     *
     * @param review Review object returned by tester execution.
     * @return Sanitized review copy.
     */
    private static Map<String, Object> sanitizeMemberVisibleReview(
        Map<String, Object> review
    ) {
        if (review == null) {
            return null;
        }

        Map<String, Object> result = new LinkedHashMap<String, Object>(review);
        Object metadata = result.get("metadata");
        if (metadata instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> metadataMap = (Map<String, Object>) metadata;
            result.put("metadata", sanitizeMemberVisibleMetadata(metadataMap));
        }
        return result;
    }

    /**
     * Sanitizes every impacted review before callback submission.
     *
     * @param reviews Review payloads returned by tester execution.
     * @return Sanitized review list.
     */
    private static List<Map<String, Object>> sanitizeMemberVisibleReviews(
        List<Map<String, Object>> reviews
    ) {
        List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();
        if (reviews == null) {
            return result;
        }

        for (Map<String, Object> review : reviews) {
            result.add(sanitizeMemberVisibleReview(review));
        }
        return result;
    }

    /**
     * Detects metadata keys that directly carry configured seed values.
     *
     * @param key Metadata key.
     * @return True when the key should not be persisted in member-visible payloads.
     */
    private static boolean isSensitiveSeedMetadataKey(String key) {
        if (key == null) {
            return false;
        }

        String normalized = key
            .replace("_", "")
            .replace("-", "")
            .toLowerCase(Locale.US);
        return "seed".equals(normalized)
            || "seeds".equals(normalized)
            || "startseed".equals(normalized)
            || "endseed".equals(normalized)
            || "phasestartseed".equals(normalized)
            || "phaseendseed".equals(normalized);
    }

    /**
     * Writes the private review payload consumed by internal Marathon Match tooling.
     * Existing non-empty tester-provided {@code reviews.json} files are preserved.
     *
     * @param submissionDir Extracted submission directory or workspace root.
     * @param submissionId Submission whose review payload is being archived.
     * @param testPhase Scoring phase represented by the review.
     * @param reviewTypeId Review API review type identifier.
     * @param scorecardId Review API scorecard identifier.
     * @param testerExecution Structured tester result used for callback creation.
     * @param callbackMetadata Metadata exactly as sent to the scoring callback.
     * @throws IOException when the private artifact directory or JSON file cannot be written.
     */
    private static void writeInternalReviewArtifact(
        Path submissionDir,
        String submissionId,
        String testPhase,
        String reviewTypeId,
        String scorecardId,
        TesterExecutionResult testerExecution,
        Map<String, Object> callbackMetadata
    ) throws IOException {
        Path privateArtifactsDir = ensurePrivateArtifactsDir(submissionDir);
        Path reviewsJsonPath = privateArtifactsDir.resolve("reviews.json");
        if (Files.isRegularFile(reviewsJsonPath) && Files.size(reviewsJsonPath) > 0L) {
            logInfo(
                "artifacts.internal-review",
                "Preserving tester-provided internal reviews artifact " + reviewsJsonPath
            );
            return;
        }

        Map<String, Object> payload = buildInternalReviewArtifactPayload(
            submissionId,
            testPhase,
            reviewTypeId,
            scorecardId,
            testerExecution,
            callbackMetadata
        );

        OBJECT_MAPPER
            .writerWithDefaultPrettyPrinter()
            .writeValue(reviewsJsonPath.toFile(), payload);
        logInfo(
            "artifacts.internal-review",
            "Wrote internal reviews artifact " + reviewsJsonPath
        );
    }

    /**
     * Ensures the private artifact directory exists for the runner workspace.
     *
     * @param submissionDir Extracted submission directory or workspace root.
     * @return Path to {@code artifacts/private}.
     * @throws IOException when directories cannot be created.
     */
    private static Path ensurePrivateArtifactsDir(Path submissionDir) throws IOException {
        if (submissionDir == null) {
            throw new IOException("submissionDir is required for internal artifacts.");
        }

        Path artifactBaseDir = resolveArtifactBaseDir(submissionDir);
        if (artifactBaseDir == null) {
            artifactBaseDir = resolveWorkspaceRoot(submissionDir);
        }

        Path privateArtifactsDir = artifactBaseDir.resolve("artifacts").resolve("private");
        Files.createDirectories(privateArtifactsDir);
        return privateArtifactsDir;
    }

    /**
     * Builds the JSON payload stored in the internal {@code reviews.json} artifact.
     *
     * @param submissionId Submission whose review payload is archived.
     * @param testPhase Scoring phase represented by the payload.
     * @param reviewTypeId Review API review type identifier.
     * @param scorecardId Review API scorecard identifier.
     * @param testerExecution Structured tester result.
     * @param callbackMetadata Metadata exactly as sent to the scoring callback.
     * @return JSON-serializable map for the internal review artifact.
     */
    private static Map<String, Object> buildInternalReviewArtifactPayload(
        String submissionId,
        String testPhase,
        String reviewTypeId,
        String scorecardId,
        TesterExecutionResult testerExecution,
        Map<String, Object> callbackMetadata
    ) {
        Map<String, Object> currentReview = withDefaultReviewFields(
            testerExecution.getCurrentReview(),
            submissionId,
            testerExecution.getScore(),
            reviewTypeId,
            scorecardId,
            callbackMetadata
        );
        List<Map<String, Object>> impactedReviews = new ArrayList<Map<String, Object>>();
        for (Map<String, Object> impactedReview : testerExecution.getImpactedReviews()) {
            impactedReviews.add(sanitizeMemberVisibleReview(impactedReview));
        }

        List<Map<String, Object>> reviews = new ArrayList<Map<String, Object>>();
        reviews.add(currentReview);
        reviews.addAll(impactedReviews);

        Map<String, Object> payload = new LinkedHashMap<String, Object>();
        payload.put("version", 1);
        payload.put("generatedAt", Instant.now().toString());
        payload.put("submissionId", submissionId);
        payload.put("testPhase", normalizeTestPhase(testPhase));
        payload.put("reviewTypeId", reviewTypeId);
        payload.put("scorecardId", scorecardId);
        payload.put("score", testerExecution.getScore());
        payload.put("metadata", callbackMetadata);
        payload.put("currentReview", currentReview);
        payload.put("impactedReviews", impactedReviews);
        payload.put("reviews", reviews);
        return payload;
    }

    /**
     * Adds the runner's callback defaults to a tester-supplied current review payload.
     *
     * @param sourceReview Current review returned by tester code, possibly empty.
     * @param submissionId Submission identifier for the review.
     * @param score Aggregate score for the review.
     * @param reviewTypeId Review API review type identifier.
     * @param scorecardId Review API scorecard identifier.
     * @param metadata Callback metadata for this phase.
     * @return Review map containing the fields needed to interpret the artifact later.
     */
    private static Map<String, Object> withDefaultReviewFields(
        Map<String, Object> sourceReview,
        String submissionId,
        double score,
        String reviewTypeId,
        String scorecardId,
        Map<String, Object> metadata
    ) {
        Map<String, Object> review = sourceReview == null
            ? new LinkedHashMap<String, Object>()
            : new LinkedHashMap<String, Object>(sourceReview);

        putIfMissing(review, "submissionId", submissionId);
        putIfMissing(review, "score", score);
        putIfMissing(review, "aggregateScore", score);
        putIfMissing(review, "typeId", reviewTypeId);
        putIfMissing(review, "reviewTypeId", reviewTypeId);
        putIfMissing(review, "scorecardId", scorecardId);
        Object reviewMetadata = review.get("metadata");
        if (reviewMetadata instanceof Map) {
            @SuppressWarnings("unchecked")
            Map<String, Object> reviewMetadataMap =
                (Map<String, Object>) reviewMetadata;
            review.put("metadata", sanitizeMemberVisibleMetadata(reviewMetadataMap));
        } else {
            putIfMissing(review, "metadata", metadata);
        }
        return review;
    }

    /**
     * Adds a field to a map when the key is absent or currently null.
     *
     * @param target Mutable map to update.
     * @param key Field name to populate.
     * @param value Field value.
     */
    private static void putIfMissing(
        Map<String, Object> target,
        String key,
        Object value
    ) {
        if (!target.containsKey(key) || target.get(key) == null) {
            target.put(key, value);
        }
    }

    /**
     * Uploads public and private submission artifacts when present.
     *
     * @param httpClient HTTP client used for multipart artifact upload.
     * @param submissionApiUrl Submission API base URL.
     * @param accessToken Bearer token with artifact upload permission.
     * @param submissionId Submission whose artifacts are uploaded.
     * @param testPhase Scoring phase represented by the artifacts.
     * @param submissionDir Extracted submission directory or workspace root.
     * @throws Exception when zip creation or upload fails.
     */
    private static void uploadArtifacts(
        CloseableHttpClient httpClient,
        String submissionApiUrl,
        String accessToken,
        String submissionId,
        String testPhase,
        Path submissionDir
    ) throws Exception {
        Path artifactBaseDir = resolveArtifactBaseDir(submissionDir);
        if (artifactBaseDir == null) {
            logWarn("artifacts.upload", "No artifact base directory found.");
            return;
        }

        Path artifactsDir = artifactBaseDir.resolve("artifacts");
        if (!Files.isDirectory(artifactsDir)) {
            logWarn(
                "artifacts.upload",
                "Artifact directory does not exist: " + artifactsDir
            );
            return;
        }

        String baseArtifactName = submissionId + "-" + testPhase;
        String internalArtifactName = baseArtifactName + "-internal";
        logInfo(
            "artifacts.upload",
            "Preparing artifact zips from " + artifactsDir
        );

        Path publicZip = null;
        Path privateZip = null;

        try {
            publicZip = createPublicArtifactZip(artifactsDir, submissionId, baseArtifactName);
            if (publicZip != null) {
                logInfo(
                    "artifacts.upload",
                    "Uploading public artifact zip " + publicZip
                );
                uploadArtifactZip(
                    httpClient,
                    submissionApiUrl,
                    accessToken,
                    submissionId,
                    baseArtifactName,
                    publicZip
                );
            }

            privateZip = createDirectoryZip(
                artifactsDir.resolve("private"),
                internalArtifactName
            );
            if (privateZip != null) {
                logInfo(
                    "artifacts.upload",
                    "Uploading private artifact zip " + privateZip
                );
                uploadArtifactZip(
                    httpClient,
                    submissionApiUrl,
                    accessToken,
                    submissionId,
                    internalArtifactName,
                    privateZip
                );
            }
        } finally {
            logInfo("artifacts.upload", "Cleaning temporary artifact zips.");
            deletePathRecursively(publicZip);
            deletePathRecursively(privateZip);
        }
    }

    /**
     * Creates public artifact archive with execution/error logs and public artifacts.
     *
     * @param artifactsDir Root artifacts directory containing public files and logs.
     * @param submissionId Submission ID used to locate execution/error logs.
     * @param artifactName Prefix used for the temporary zip file.
     * @return Temporary zip path, or {@code null} when no public files exist.
     * @throws Exception when walking or archiving public artifacts fails.
     */
    private static Path createPublicArtifactZip(
        Path artifactsDir,
        String submissionId,
        String artifactName
    ) throws Exception {
        Path executionLog = artifactsDir.resolve("execution-" + submissionId + ".log");
        Path errorLog = artifactsDir.resolve("error-" + submissionId + ".log");
        Path publicDir = artifactsDir.resolve("public");

        boolean hasPublicArtifacts =
            Files.isRegularFile(executionLog)
                || Files.isRegularFile(errorLog)
                || directoryHasRegularFiles(publicDir);

        if (!hasPublicArtifacts) {
            logInfo(
                "artifacts.zip.public",
                "No public artifacts found under " + artifactsDir
            );
            return null;
        }

        Path zipPath = Files.createTempFile(artifactName + "-", ".zip");
        try (ZipOutputStream zipOutputStream = new ZipOutputStream(
            Files.newOutputStream(zipPath)
        )) {
            addFileToZip(zipOutputStream, executionLog, executionLog.getFileName().toString());
            addFileToZip(zipOutputStream, errorLog, errorLog.getFileName().toString());
            addDirectoryToZip(zipOutputStream, publicDir, "");
        }
        logInfo(
            "artifacts.zip.public",
            "Created public zip " + zipPath + " (" + Files.size(zipPath) + " bytes)"
        );

        return zipPath;
    }

    /**
     * Creates a zip archive from a directory with at least one regular file.
     *
     * @param directoryPath Directory to archive.
     * @param artifactName Prefix used for the temporary zip file.
     * @return Temporary zip path, or {@code null} when the directory is missing or empty.
     * @throws Exception when walking or archiving the directory fails.
     */
    private static Path createDirectoryZip(Path directoryPath, String artifactName)
        throws Exception {
        if (!Files.isDirectory(directoryPath)) {
            logInfo(
                "artifacts.zip.private",
                "Directory does not exist, skipping zip: " + directoryPath
            );
            return null;
        }

        if (!directoryHasRegularFiles(directoryPath)) {
            logInfo(
                "artifacts.zip.private",
                "No files found, skipping zip: " + directoryPath
            );
            return null;
        }

        Path zipPath = Files.createTempFile(artifactName + "-", ".zip");
        try (ZipOutputStream zipOutputStream = new ZipOutputStream(
            Files.newOutputStream(zipPath)
        )) {
            addDirectoryToZip(zipOutputStream, directoryPath, "");
        }
        logInfo(
            "artifacts.zip.private",
            "Created zip " + zipPath + " from " + directoryPath
        );

        return zipPath;
    }

    /**
     * Checks whether a directory contains at least one regular file.
     *
     * @param directoryPath Directory to inspect.
     * @return {@code true} when the directory exists and contains a regular file.
     * @throws IOException when walking the directory fails.
     */
    private static boolean directoryHasRegularFiles(Path directoryPath) throws IOException {
        if (!Files.isDirectory(directoryPath)) {
            return false;
        }

        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            return stream.anyMatch(Files::isRegularFile);
        }
    }

    /**
     * Adds a file to zip when it exists.
     */
    private static void addFileToZip(
        ZipOutputStream zipOutputStream,
        Path filePath,
        String entryName
    ) throws Exception {
        if (!Files.isRegularFile(filePath)) {
            logInfo("artifacts.zip.add-file", "Skipping missing file: " + filePath);
            return;
        }

        logInfo(
            "artifacts.zip.add-file",
            "Adding file to zip entry " + entryName + " from " + filePath
        );
        zipOutputStream.putNextEntry(new ZipEntry(entryName.replace('\\', '/')));
        Files.copy(filePath, zipOutputStream);
        zipOutputStream.closeEntry();
    }

    /**
     * Recursively adds directory contents to a zip stream.
     */
    private static void addDirectoryToZip(
        ZipOutputStream zipOutputStream,
        Path directoryPath,
        String entryPrefix
    ) throws Exception {
        if (!Files.isDirectory(directoryPath)) {
            logInfo(
                "artifacts.zip.add-directory",
                "Skipping missing directory: " + directoryPath
            );
            return;
        }

        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            List<Path> paths = new ArrayList<Path>();
            stream.forEach(paths::add);

            for (Path entryPath : paths) {
                if (!Files.isRegularFile(entryPath)) {
                    continue;
                }

                String relativePath = directoryPath
                    .relativize(entryPath)
                    .toString()
                    .replace('\\', '/');
                String entryName = entryPrefix + relativePath;

                logInfo(
                    "artifacts.zip.add-directory",
                    "Adding entry " + entryName + " from " + entryPath
                );
                zipOutputStream.putNextEntry(new ZipEntry(entryName));
                Files.copy(entryPath, zipOutputStream);
                zipOutputStream.closeEntry();
            }
        }
    }

    /**
     * Uploads zip artifact to submission-api using multipart form data.
     */
    private static void uploadArtifactZip(
        CloseableHttpClient httpClient,
        String submissionApiUrl,
        String accessToken,
        String submissionId,
        String artifactName,
        Path zipPath
    ) throws Exception {
        String encodedFilename = URLEncoder.encode(artifactName, "UTF-8")
            .replace("+", "%20");

        String url =
            normalizeBaseUrl(submissionApiUrl)
                + "/submissions/"
                + submissionId
                + "/artifacts?filename="
                + encodedFilename;

        HttpPost request = new HttpPost(url);
        request.setHeader("Authorization", "Bearer " + accessToken);
        logInfo(
            "http.post.artifact",
            "POST "
                + url
                + " artifactName="
                + artifactName
                + ", zipPath="
                + zipPath
                + ", sizeBytes="
                + Files.size(zipPath)
        );

        HttpEntity entity = MultipartEntityBuilder
            .create()
            .addBinaryBody(
                "file",
                zipPath.toFile(),
                ContentType.APPLICATION_OCTET_STREAM,
                artifactName + ".zip"
            )
            .build();

        request.setEntity(entity);

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
            logInfo(
                "http.post.artifact",
                "POST "
                    + url
                    + " returned HTTP "
                    + statusCode
                    + ", responsePreview="
                    + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
            );

            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "POST " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }
        }
    }

    /**
     * Locates an artifact file across known runner workspace roots.
     */
    private static Path findArtifactFile(Path submissionDir, String relativePath) {
        for (Path baseDir : getArtifactBaseCandidates(submissionDir)) {
            Path candidate = baseDir.resolve("artifacts").resolve(relativePath);
            if (Files.isRegularFile(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    /**
     * Locates the base directory that contains artifacts.
     */
    private static Path resolveArtifactBaseDir(Path submissionDir) {
        for (Path baseDir : getArtifactBaseCandidates(submissionDir)) {
            if (Files.isDirectory(baseDir.resolve("artifacts"))) {
                return baseDir;
            }
        }

        return null;
    }

    /**
     * Returns possible workspace roots used by MM runner/tester layouts.
     */
    private static List<Path> getArtifactBaseCandidates(Path submissionDir) {
        List<Path> candidates = new ArrayList<Path>();

        if (submissionDir != null) {
            candidates.add(submissionDir.resolve("submission"));
            candidates.add(submissionDir);
        }

        candidates.add(Paths.get("/workdir/submission"));
        candidates.add(Paths.get("/workdir"));

        return candidates;
    }

    /**
     * Writes tester JAR bytes to deterministic tmp path.
     */
    private static Path writeTesterJar(String testerConfigId, byte[] jarBytes)
        throws IOException {
        Path jarPath = Paths.get("/tmp/tester-" + testerConfigId + ".jar");
        Files.write(jarPath, jarBytes);
        logInfo(
            "filesystem.testerJar",
            "Wrote tester JAR to " + jarPath + " (" + Files.size(jarPath) + " bytes)"
        );
        return jarPath;
    }

    /**
     * Builds scorer config consumed by Marathon tester execution.
     *
     * @param config Marathon Match challenge configuration fetched from the API.
     * @param tester Compiled tester metadata fetched from the API.
     * @param reviewTypeId Review type ID written to callback metadata.
     * @param phaseStartSeed First seed in the configured phase range.
     * @param phaseNumberOfTests Number of seeds configured for the phase.
     * @return ScorerConfig passed to generic or custom tester execution.
     * @throws IllegalArgumentException When the configured seed range exceeds Java long bounds.
     */
    private static ScorerConfig buildScorerConfig(
        MarathonMatchConfigResponse config,
        TesterResponse tester,
        String reviewTypeId,
        long phaseStartSeed,
        int phaseNumberOfTests
    ) {
        int resolvedNumberOfTests = resolvePositiveInt(phaseNumberOfTests, 1);
        if (phaseStartSeed < 0L) {
            throw new IllegalArgumentException("PHASE_START_SEED must be non-negative.");
        }
        if (phaseStartSeed > Long.MAX_VALUE - resolvedNumberOfTests + 1L) {
            throw new IllegalArgumentException(
                "PHASE_START_SEED plus PHASE_NUMBER_OF_TESTS exceeds Java long maximum value."
            );
        }

        ScorerConfig scorerConfig = new ScorerConfig();
        scorerConfig.setName(config.getChallengeIdOrId());
        scorerConfig.setTesterClass(tester.getClassName());
        scorerConfig.setScoreCardId(config.getReviewScorecardId());
        scorerConfig.setReviewerId(UUID.randomUUID().toString());
        scorerConfig.setTypeId(reviewTypeId);
        scorerConfig.setStartSeed(phaseStartSeed);
        scorerConfig.setNumberOfTests(phaseNumberOfTests);
        scorerConfig.setTimeLimit(config.getTestTimeout());
        scorerConfig.setTimeout(config.getTestTimeout());
        scorerConfig.setCompileTimeout(config.getCompileTimeout());
        logInfo(
            "config.scorer",
            "Constructed scorer config for tester class " + tester.getClassName()
        );
        return scorerConfig;
    }

    /**
     * Loads the tester class from the downloaded JAR and runs scorer execution.
     *
     * <p>Custom testers that expose {@code runTester(String, ScorerConfig)} are still
     * supported for backward compatibility. Standard Topcoder Marathon testers can omit that
     * method; in that case this runner locates, compiles, and executes the submitted source via
     * {@link MarathonController}.
     *
     * @param testerClassName Fully qualified Marathon tester class name.
     * @param submissionDir Extracted submission directory.
     * @param scorerConfig Phase scoring configuration from marathon-match-api-v6.
     * @param testerJarPath Downloaded tester JAR path.
     * @return Structured tester execution result used for callback payloads.
     * @throws Exception When class loading, custom invocation, generic compilation, or test
     *                   execution fails.
     */
    private static TesterExecutionResult runTester(
        String testerClassName,
        String submissionDir,
        ScorerConfig scorerConfig,
        Path testerJarPath
    ) throws Exception {
        URL[] urls = new URL[] { testerJarPath.toUri().toURL() };
        logInfo(
            "tester.invoke",
            "Loading tester class from JAR " + testerJarPath + " with URLClassLoader"
        );
        try (URLClassLoader loader = new URLClassLoader(
            urls,
            EcsRunnerMain.class.getClassLoader()
        )) {
            Thread currentThread = Thread.currentThread();
            ClassLoader originalContextLoader = currentThread.getContextClassLoader();
            currentThread.setContextClassLoader(loader);
            try {
                Class<?> testerClass = Class.forName(testerClassName, true, loader);
                logInfo(
                    "tester.invoke",
                    "Resolved tester class "
                        + testerClass.getName()
                        + ". Looking for optional runTester method."
                );
                Method runTesterMethod = findCustomRunTesterMethod(testerClass);
                if (runTesterMethod == null) {
                    logInfo(
                        "tester.invoke",
                        "No custom runTester(String, ScorerConfig) found. "
                            + "Using generic MarathonController execution."
                    );
                    return runGenericMarathonTester(
                        testerClassName,
                        submissionDir,
                        scorerConfig
                    );
                }

                logInfo(
                    "tester.invoke",
                    "Invoking runTester(String, ScorerConfig) on class "
                        + testerClassName
                );
                Object runResult = invokeCustomRunTester(
                    runTesterMethod,
                    submissionDir,
                    scorerConfig
                );
                logInfo(
                    "tester.invoke",
                    "runTester returned instance of "
                        + (runResult == null
                            ? "<null>"
                            : runResult.getClass().getName())
                );
                return parseTesterExecutionResult(runResult, testerClassName);
            } finally {
                currentThread.setContextClassLoader(originalContextLoader);
            }
        }
    }

    /**
     * Finds the optional custom tester entrypoint used by older tester artifacts.
     *
     * @param testerClass Loaded tester class from the tester JAR.
     * @return Public {@code runTester(String, ScorerConfig)} method, or {@code null} when the
     *         tester only supports standard MarathonController execution.
     */
    private static Method findCustomRunTesterMethod(Class<?> testerClass) {
        try {
            return testerClass.getMethod("runTester", String.class, ScorerConfig.class);
        } catch (NoSuchMethodException ignored) {
            return null;
        }
    }

    /**
     * Invokes a custom tester entrypoint and unwraps reflective exceptions.
     *
     * @param runTesterMethod Public custom tester method.
     * @param submissionDir Extracted submission directory.
     * @param scorerConfig Scorer configuration passed to custom tester code.
     * @return Raw return value from custom tester code.
     * @throws Exception When custom tester code throws or reflection cannot invoke the method.
     */
    private static Object invokeCustomRunTester(
        Method runTesterMethod,
        String submissionDir,
        ScorerConfig scorerConfig
    ) throws Exception {
        try {
            return runTesterMethod.invoke(null, submissionDir, scorerConfig);
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            if (cause instanceof Exception) {
                throw (Exception) cause;
            }
            if (cause instanceof Error) {
                throw (Error) cause;
            }
            throw new RuntimeException(cause);
        }
    }

    /**
     * Runs a standard Topcoder Marathon tester without requiring tester-specific ECS code.
     *
     * <p>The method creates artifact directories, selects a supported submission source file,
     * compiles it when needed, runs the configured tester for every seed in the phase range, and
     * returns the aggregate score plus per-test metadata used by relative scoring.
     *
     * @param testerClassName Fully qualified Marathon tester class name.
     * @param submissionPath Extracted submission directory.
     * @param scorerConfig Phase scoring configuration with seeds and timeout values.
     * @return Structured tester execution result for callback creation.
     * @throws Exception When submission validation, source discovery, seed range validation,
     *                   compilation, test execution, or artifact writing fails.
     */
    private static TesterExecutionResult runGenericMarathonTester(
        String testerClassName,
        String submissionPath,
        ScorerConfig scorerConfig
    ) throws Exception {
        if (submissionPath == null || submissionPath.trim().isEmpty()) {
            throw new IllegalArgumentException("submissionPath is required.");
        }
        if (scorerConfig == null) {
            throw new IllegalArgumentException("ScorerConfig is required.");
        }

        Path submissionRoot = Paths.get(submissionPath);
        if (!Files.isDirectory(submissionRoot)) {
            throw new IllegalArgumentException(
                "Submission directory does not exist: " + submissionRoot
            );
        }

        Path workspaceRoot = resolveWorkspaceRoot(submissionRoot);
        Path artifactsRoot = workspaceRoot.resolve("artifacts");
        Path artifactsPublicDir = artifactsRoot.resolve("public");
        Path artifactsPrivateDir = artifactsRoot.resolve("private");
        Files.createDirectories(artifactsPublicDir);
        Files.createDirectories(artifactsPrivateDir);

        String expectedSolutionBaseName = deriveExpectedSolutionBaseName(testerClassName);
        Path submissionSource = locateSubmissionSource(
            submissionRoot,
            expectedSolutionBaseName
        );

        int timeLimitMs = resolvePositiveInt(
            scorerConfig.getTimeLimit(),
            DEFAULT_TEST_TIMEOUT_MS
        );
        int compileTimeoutMs = resolvePositiveInt(
            scorerConfig.getCompileTimeout(),
            DEFAULT_COMPILE_TIMEOUT_MS
        );
        long startSeed = scorerConfig.getStartSeed();
        int numberOfTests = resolvePositiveInt(scorerConfig.getNumberOfTests(), 1);
        if (startSeed < 0L) {
            throw new IllegalArgumentException("startSeed must be non-negative.");
        }
        if (startSeed > Long.MAX_VALUE - numberOfTests + 1L) {
            throw new IllegalArgumentException(
                "Configured seed range exceeds Java long maximum value."
            );
        }
        Path compileWorkDir = Files.createTempDirectory("mm-submission-solution-");
        Path compileLogPath = artifactsPublicDir.resolve("compile_log.txt");

        try {
            CompiledSubmission compiledSubmission = compileAndBuildExecutionCommand(
                submissionSource,
                compileWorkDir,
                compileTimeoutMs,
                expectedSolutionBaseName,
                compileLogPath
            );

            MarathonController controller = new MarathonController();
            List<Map<String, Object>> testScores = new ArrayList<Map<String, Object>>();
            double totalScore = 0.0;
            int failedTests = 0;
            StringBuilder outputText = new StringBuilder();

            long endSeed = startSeed + numberOfTests - 1L;
            for (long seed = startSeed; seed <= endSeed; seed++) {
                int testCaseNumber = testScores.size() + 1;
                MarathonTestResult testResult = controller.run(
                    testerClassName,
                    seed,
                    compiledSubmission.getExecutionCommand(),
                    timeLimitMs
                );

                double seedScore = testResult.getScore();
                totalScore += seedScore;
                String seedError = testResult.getError();
                if (seedScore < 0 || (seedError != null && !seedError.trim().isEmpty())) {
                    failedTests += 1;
                }

                Map<String, Object> seedResult = new LinkedHashMap<String, Object>();
                seedResult.put("testcase", Integer.toString(testCaseNumber));
                seedResult.put("score", seedScore);
                seedResult.put("runTimeMs", testResult.getRunTime());
                seedResult.put("error", seedError);
                testScores.add(seedResult);

                outputText.append("Test Case #").append(testCaseNumber).append(":\n");
                outputText.append("Score = ").append(seedScore).append('\n');
                outputText.append("Run Time = ")
                    .append(testResult.getRunTime())
                    .append("ms\n");
                if (
                    testResult.getError() != null
                        && !testResult.getError().trim().isEmpty()
                ) {
                    outputText.append(testResult.getError().trim()).append('\n');
                }
                if (
                    testResult.getOutput() != null
                        && !testResult.getOutput().trim().isEmpty()
                ) {
                    outputText.append(testResult.getOutput().trim()).append('\n');
                }
                outputText.append('\n');

                emitIsolatedTesterProgress(
                    testScores.size(),
                    numberOfTests,
                    failedTests,
                    failedTests > 0 ? TEST_STATUS_FAILED : TEST_STATUS_IN_PROGRESS,
                    "Completed test " + testCaseNumber + " of " + numberOfTests
                );
            }

            double averageScore = testScores.isEmpty()
                ? 0.0
                : totalScore / testScores.size();

            try (BufferedWriter writer = Files.newBufferedWriter(
                artifactsPublicDir.resolve("output.txt"),
                StandardCharsets.UTF_8
            )) {
                writer.write(outputText.toString());
            }

            Map<String, Object> metadata = new LinkedHashMap<String, Object>();
            metadata.put("testerClass", testerClassName);
            metadata.put("solutionSourceFile", submissionSource.getFileName().toString());
            metadata.put("normalizedSourceFile", compiledSubmission.getSourceFileName());
            metadata.put("sourceLanguage", compiledSubmission.getSourceLanguage());
            metadata.put("numberOfTests", numberOfTests);
            metadata.put("timeLimitMs", timeLimitMs);
            metadata.put("compileTimeoutMs", compileTimeoutMs);
            metadata.put("aggregateMode", "average");
            metadata.put("testScores", testScores);

            Map<String, Object> currentReview = new LinkedHashMap<String, Object>();
            currentReview.put("score", averageScore);
            currentReview.put("aggregateScore", averageScore);
            currentReview.put("metadata", metadata);

            return new TesterExecutionResult(
                averageScore,
                metadata,
                currentReview,
                new ArrayList<Map<String, Object>>()
            );
        } finally {
            deletePathRecursively(compileWorkDir);
        }
    }

    /**
     * Emits a progress marker for the trusted parent process to forward to the API.
     *
     * @param completedTests Number of seeds completed by the generic runner.
     * @param totalTests Total seed count configured for the scoring phase.
     * @param failedTests Number of completed tests that reported errors.
     * @param status Current progress status.
     * @param message Short progress message for metadata diagnostics.
     */
    private static void emitIsolatedTesterProgress(
        int completedTests,
        int totalTests,
        int failedTests,
        String status,
        String message
    ) {
        try {
            Map<String, Object> progress = new LinkedHashMap<String, Object>();
            double progressValue = totalTests <= 0
                ? 0.0
                : Math.min(1.0, Math.max(0.0, (double) completedTests / totalTests));
            progress.put("progress", progressValue);
            progress.put("status", status);
            progress.put("completedTests", completedTests);
            progress.put("totalTests", totalTests);
            progress.put("failedTests", failedTests);
            progress.put("message", message);

            String serializedProgress = OBJECT_MAPPER.writeValueAsString(progress);
            String encodedProgress = Base64
                .getEncoder()
                .encodeToString(serializedProgress.getBytes(StandardCharsets.UTF_8));
            System.out.println(ISOLATED_TESTER_PROGRESS_MARKER + encodedProgress);
        } catch (Exception error) {
            logWarn(
                "tester.progress",
                "Unable to emit isolated tester progress: " + error.getMessage()
            );
        }
    }

    /**
     * Chooses the workspace root where public/private artifacts should be written.
     *
     * @param submissionRoot Extracted submission root.
     * @return Nested {@code submission} directory when present, otherwise the extracted root.
     */
    private static Path resolveWorkspaceRoot(Path submissionRoot) {
        Path nestedSubmissionDir = submissionRoot.resolve("submission");
        return Files.isDirectory(nestedSubmissionDir) ? nestedSubmissionDir : submissionRoot;
    }

    /**
     * Locates a supported source file in extracted submission content.
     *
     * @param submissionRoot Extracted submission root.
     * @param expectedSolutionBaseName Preferred problem solution base name inferred from the
     *                                 tester class, such as {@code BridgeRunners}.
     * @return Selected source file path.
     * @throws IOException When walking the submission directory fails.
     * @throws IllegalArgumentException When no supported source file is found.
     */
    private static Path locateSubmissionSource(
        Path submissionRoot,
        String expectedSolutionBaseName
    ) throws IOException {
        List<Path> candidates = new ArrayList<Path>();
        try (java.util.stream.Stream<Path> stream = Files.walk(submissionRoot)) {
            stream
                .filter(path -> Files.isRegularFile(path))
                .filter(path -> !isIgnoredSubmissionSource(path))
                .filter(path -> isSupportedSource(path.getFileName().toString()))
                .forEach(candidates::add);
        }

        if (candidates.isEmpty()) {
            throw new IllegalArgumentException(
                "No supported submission source was found under "
                    + submissionRoot
                    + ". Expected one of: "
                    + SUPPORTED_SOURCE_EXTENSIONS
            );
        }

        Path preferred = findPreferredSubmissionSource(
            candidates,
            expectedSolutionBaseName
        );
        if (preferred != null) {
            return preferred;
        }

        candidates.sort(new Comparator<Path>() {
            @Override
            public int compare(Path left, Path right) {
                int extensionCompare = Integer.compare(
                    sourceExtensionRank(left),
                    sourceExtensionRank(right)
                );
                if (extensionCompare != 0) {
                    return extensionCompare;
                }
                return left.toAbsolutePath()
                    .toString()
                    .compareTo(right.toAbsolutePath().toString());
            }
        });
        return candidates.get(0);
    }

    /**
     * Checks whether a submission path should be ignored during source discovery.
     *
     * @param path Candidate file path from the extracted submission.
     * @return {@code true} for metadata/resource fork files and generated artifact paths.
     */
    private static boolean isIgnoredSubmissionSource(Path path) {
        String fileName = path.getFileName() == null
            ? ""
            : path.getFileName().toString();
        if (fileName.startsWith("._")) {
            return true;
        }

        for (Path part : path) {
            String value = part.toString();
            if ("__MACOSX".equals(value) || "artifacts".equals(value)) {
                return true;
            }
        }
        return false;
    }

    /**
     * Selects a source file whose filename matches the inferred problem solution base name.
     *
     * @param candidates Supported source candidates.
     * @param expectedSolutionBaseName Inferred solution base name, or blank when unknown.
     * @return Preferred source path, or {@code null} when none match.
     */
    private static Path findPreferredSubmissionSource(
        List<Path> candidates,
        String expectedSolutionBaseName
    ) {
        if (expectedSolutionBaseName == null || expectedSolutionBaseName.trim().isEmpty()) {
            return null;
        }

        for (String extension : SUPPORTED_SOURCE_EXTENSIONS) {
            String expectedFileName = expectedSolutionBaseName + extension;
            for (Path candidate : candidates) {
                if (candidate.getFileName().toString().equalsIgnoreCase(expectedFileName)) {
                    return candidate;
                }
            }
        }
        return null;
    }

    /**
     * Checks whether a filename has a source extension supported by the generic runner.
     *
     * @param fileName Candidate filename.
     * @return {@code true} for C++, Java, Python, Mono C#, .NET 10 C#, or Rust submissions.
     */
    private static boolean isSupportedSource(String fileName) {
        return SUPPORTED_SOURCE_EXTENSIONS.contains(extensionOf(fileName).toLowerCase(Locale.US));
    }

    /**
     * Ranks source extensions for deterministic fallback selection.
     *
     * @param path Candidate source path.
     * @return Lower rank for more preferred extensions.
     */
    private static int sourceExtensionRank(Path path) {
        String extension = extensionOf(path.getFileName().toString()).toLowerCase(Locale.US);
        int rank = SUPPORTED_SOURCE_EXTENSIONS.indexOf(extension);
        return rank < 0 ? Integer.MAX_VALUE : rank;
    }

    /**
     * Extracts a supported source extension from a filename.
     *
     * @param fileName Source filename.
     * @return Extension with leading dot, preserving special .NET C# extensions.
     */
    private static String extensionOf(String fileName) {
        String lower = fileName.toLowerCase(Locale.US);
        if (lower.endsWith(".cs_net10")) {
            return ".cs_net10";
        }
        if (lower.endsWith(".cs_net7")) {
            return ".cs_net7";
        }

        int dotIndex = fileName.lastIndexOf('.');
        if (dotIndex < 0) {
            return "";
        }
        return fileName.substring(dotIndex);
    }

    /**
     * Returns a filename without its supported source extension.
     *
     * @param fileName Source filename.
     * @return Filename base without extension.
     */
    private static String sourceBaseName(String fileName) {
        String extension = extensionOf(fileName);
        if (extension.isEmpty()) {
            return fileName;
        }
        return fileName.substring(0, fileName.length() - extension.length());
    }

    /**
     * Infers the expected Marathon solution class/file base name from the tester class.
     *
     * @param testerClassName Fully qualified tester class name.
     * @return Simple class name with a trailing {@code Tester} suffix removed when present.
     */
    private static String deriveExpectedSolutionBaseName(String testerClassName) {
        if (testerClassName == null || testerClassName.trim().isEmpty()) {
            return "";
        }

        String simpleName = testerClassName.trim();
        int dotIndex = simpleName.lastIndexOf('.');
        if (dotIndex >= 0) {
            simpleName = simpleName.substring(dotIndex + 1);
        }

        String suffix = "Tester";
        if (simpleName.endsWith(suffix) && simpleName.length() > suffix.length()) {
            return simpleName.substring(0, simpleName.length() - suffix.length());
        }
        return simpleName;
    }

    /**
     * Compiles a submission source when needed and builds the command used by MarathonController.
     *
     * @param sourceFile Selected source file from the extracted submission.
     * @param workDir Temporary compile working directory.
     * @param compileTimeoutMs Compile timeout in milliseconds.
     * @param expectedSolutionBaseName Inferred solution base name for source normalization.
     * @param compileLogPath Public artifact file that receives compiler output.
     * @return Compiled submission details, including the executable command string.
     * @throws Exception When source copying, project generation, compilation, or language
     *                   detection fails.
     */
    private static CompiledSubmission compileAndBuildExecutionCommand(
        Path sourceFile,
        Path workDir,
        int compileTimeoutMs,
        String expectedSolutionBaseName,
        Path compileLogPath
    ) throws Exception {
        String extension = extensionOf(sourceFile.getFileName().toString()).toLowerCase(Locale.US);
        String language = sourceLanguageName(extension);

        if (".java".equals(extension)) {
            JavaEntryPoint entryPoint = resolveJavaEntryPoint(
                sourceFile,
                expectedSolutionBaseName
            );
            Path packageDir = resolveJavaPackageDirectory(workDir, entryPoint.getPackageName());
            Files.createDirectories(packageDir);
            Path normalizedSource = packageDir.resolve(entryPoint.getClassName() + ".java");
            Files.copy(sourceFile, normalizedSource, StandardCopyOption.REPLACE_EXISTING);

            runCommand(
                Arrays.asList("javac", workDir.relativize(normalizedSource).toString()),
                workDir,
                compileTimeoutMs,
                "Java compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                "java -Xms1G -Xmx1G -cp "
                    + workDir.toAbsolutePath()
                    + " "
                    + entryPoint.getQualifiedClassName(),
                normalizedSource.getFileName().toString(),
                language
            );
        }

        Path normalizedSource = workDir.resolve(GENERIC_SOLUTION_BASE_NAME + extension);
        Files.copy(sourceFile, normalizedSource, StandardCopyOption.REPLACE_EXISTING);

        if (".cpp".equals(extension)) {
            String binaryPath = workDir
                .resolve(GENERIC_SOLUTION_BASE_NAME)
                .toAbsolutePath()
                .toString();
            runCommand(
                Arrays.asList(
                    "g++",
                    "-std=gnu++23",
                    "-O3",
                    "-march=native",
                    normalizedSource.getFileName().toString(),
                    "-o",
                    binaryPath
                ),
                workDir,
                compileTimeoutMs,
                "C++ compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                binaryPath,
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".py".equals(extension)) {
            return new CompiledSubmission(
                "python3 " + normalizedSource.toAbsolutePath(),
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".rs".equals(extension)) {
            String binaryPath = workDir
                .resolve(GENERIC_SOLUTION_BASE_NAME)
                .toAbsolutePath()
                .toString();
            runCommand(
                Arrays.asList(
                    "rustc",
                    "--edition=2024",
                    "-O",
                    normalizedSource.getFileName().toString(),
                    "-o",
                    binaryPath
                ),
                workDir,
                compileTimeoutMs,
                "Rust compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                binaryPath,
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".cs".equals(extension)) {
            String exePath = workDir
                .resolve(GENERIC_SOLUTION_BASE_NAME + ".exe")
                .toAbsolutePath()
                .toString();
            runCommand(
                Arrays.asList(
                    "mcs",
                    "/r:System.Numerics.dll",
                    "-out:" + exePath,
                    normalizedSource.getFileName().toString()
                ),
                workDir,
                compileTimeoutMs,
                "C# (Mono) compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                "mono " + exePath,
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".cs_net10".equals(extension) || ".cs_net7".equals(extension)) {
            Path csproj = workDir.resolve(GENERIC_SOLUTION_BASE_NAME + ".csproj");
            Files.write(
                csproj,
                Arrays.asList(
                    "<Project Sdk=\"Microsoft.NET.Sdk\">",
                    "  <PropertyGroup>",
                    "    <TargetFramework>net10.0</TargetFramework>",
                    "    <OutputType>Exe</OutputType>",
                    "    <AllowUnsafeBlocks>true</AllowUnsafeBlocks>",
                    "  </PropertyGroup>",
                    "</Project>"
                ),
                StandardCharsets.UTF_8
            );

            Path normalizedCsSource = workDir.resolve(GENERIC_SOLUTION_BASE_NAME + ".cs");
            Files.copy(sourceFile, normalizedCsSource, StandardCopyOption.REPLACE_EXISTING);
            Path publishDir = workDir.resolve(GENERIC_SOLUTION_BASE_NAME);
            runCommand(
                Arrays.asList(
                    "dotnet",
                    "publish",
                    csproj.getFileName().toString(),
                    "-c",
                    "Release",
                    "-o",
                    publishDir.toAbsolutePath().toString()
                ),
                workDir,
                compileTimeoutMs,
                "C# (.NET 10) compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                "dotnet "
                    + publishDir
                        .resolve(GENERIC_SOLUTION_BASE_NAME + ".dll")
                        .toAbsolutePath(),
                normalizedCsSource.getFileName().toString(),
                language
            );
        }

        throw new IllegalArgumentException("Unsupported submission extension: " + extension);
    }

    /**
     * Converts a supported extension into a readable metadata language label.
     *
     * @param extension Supported source extension.
     * @return Language label for scorer metadata.
     */
    private static String sourceLanguageName(String extension) {
        if (".cpp".equals(extension)) {
            return "cpp";
        }
        if (".java".equals(extension)) {
            return "java";
        }
        if (".py".equals(extension)) {
            return "python";
        }
        if (".cs".equals(extension)) {
            return "csharp-mono";
        }
        if (".cs_net10".equals(extension) || ".cs_net7".equals(extension)) {
            return "csharp-net10";
        }
        if (".rs".equals(extension)) {
            return "rust";
        }
        return "unknown";
    }

    /**
     * Parses Java package/class names so Java submissions can be compiled under the correct file.
     *
     * @param sourceFile Java source path.
     * @param expectedSolutionBaseName Inferred solution class name used as a fallback preference.
     * @return Java entrypoint information for compiling and executing the submission.
     * @throws IOException When reading the source file fails.
     */
    private static JavaEntryPoint resolveJavaEntryPoint(
        Path sourceFile,
        String expectedSolutionBaseName
    ) throws IOException {
        String sourceText = new String(Files.readAllBytes(sourceFile), StandardCharsets.UTF_8);
        String packageName = "";
        Matcher packageMatcher = JAVA_PACKAGE_PATTERN.matcher(sourceText);
        if (packageMatcher.find()) {
            packageName = packageMatcher.group(1);
        }

        String className = findJavaClassName(sourceText, expectedSolutionBaseName);
        if (className == null || className.trim().isEmpty()) {
            className = sourceBaseName(sourceFile.getFileName().toString());
        }

        return new JavaEntryPoint(packageName, className);
    }

    /**
     * Finds the Java class that should be launched for a Java submission.
     *
     * @param sourceText Java source content.
     * @param expectedSolutionBaseName Preferred solution class name inferred from tester class.
     * @return Public class name, expected class name when present, first class name, or null.
     */
    private static String findJavaClassName(
        String sourceText,
        String expectedSolutionBaseName
    ) {
        Matcher publicClassMatcher = JAVA_PUBLIC_CLASS_PATTERN.matcher(sourceText);
        if (publicClassMatcher.find()) {
            return publicClassMatcher.group(1);
        }

        if (
            expectedSolutionBaseName != null
                && !expectedSolutionBaseName.trim().isEmpty()
                && sourceText.matches("(?s).*\\bclass\\s+"
                    + Pattern.quote(expectedSolutionBaseName)
                    + "\\b.*")
        ) {
            return expectedSolutionBaseName;
        }

        Matcher classMatcher = JAVA_CLASS_PATTERN.matcher(sourceText);
        if (classMatcher.find()) {
            return classMatcher.group(1);
        }
        return null;
    }

    /**
     * Resolves the package directory where Java source should be copied before compilation.
     *
     * @param workDir Temporary compile root.
     * @param packageName Java package name, or blank for the default package.
     * @return Directory where the normalized Java source file should be written.
     */
    private static Path resolveJavaPackageDirectory(Path workDir, String packageName) {
        Path packageDir = workDir;
        if (packageName == null || packageName.trim().isEmpty()) {
            return packageDir;
        }

        String[] parts = packageName.split("\\.");
        for (String part : parts) {
            packageDir = packageDir.resolve(part);
        }
        return packageDir;
    }

    /**
     * Executes a compiler command with timeout and appends compiler output to an artifact log.
     *
     * @param command Command and arguments.
     * @param workDir Working directory for the compiler process.
     * @param timeoutMs Timeout in milliseconds.
     * @param failureContext Message prefix used when compilation fails.
     * @param logFile Public artifact log file for compiler output.
     * @throws Exception When the process cannot start, times out, is interrupted, or exits
     *                   unsuccessfully.
     */
    private static void runCommand(
        List<String> command,
        Path workDir,
        int timeoutMs,
        String failureContext,
        Path logFile
    ) throws Exception {
        Files.createDirectories(logFile.getParent());
        appendText(logFile, "$ " + String.join(" ", command) + "\n");

        ProcessBuilder processBuilder = new ProcessBuilder(command);
        processBuilder.directory(workDir.toFile());
        processBuilder.redirectErrorStream(true);
        processBuilder.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile.toFile()));

        Process process;
        try {
            process = processBuilder.start();
        } catch (IOException error) {
            throw new RuntimeException(
                failureContext
                    + " Unable to start command '"
                    + String.join(" ", command)
                    + "'.",
                error
            );
        }

        boolean finished = process.waitFor(timeoutMs, TimeUnit.MILLISECONDS);
        if (!finished) {
            process.destroyForcibly();
            appendText(
                logFile,
                "\nTimed out after " + timeoutMs + "ms.\n"
            );
            throw new RuntimeException(
                failureContext
                    + " Timed out after "
                    + timeoutMs
                    + "ms: "
                    + String.join(" ", command)
            );
        }

        int exitCode = process.exitValue();
        appendText(logFile, "\nExit code: " + exitCode + "\n");
        if (exitCode != 0) {
            throw new RuntimeException(
                failureContext
                    + " Exit code "
                    + exitCode
                    + ": "
                    + String.join(" ", command)
            );
        }
    }

    /**
     * Appends UTF-8 text to a file, creating the file when needed.
     *
     * @param filePath File to append.
     * @param text Text to write.
     * @throws IOException When the append operation fails.
     */
    private static void appendText(Path filePath, String text) throws IOException {
        try (BufferedWriter writer = Files.newBufferedWriter(
            filePath,
            StandardCharsets.UTF_8,
            java.nio.file.StandardOpenOption.CREATE,
            java.nio.file.StandardOpenOption.APPEND
        )) {
            writer.write(text);
        }
    }

    /**
     * Returns a fallback value when a configured integer is not positive.
     *
     * @param configured Configured value.
     * @param fallback Default value.
     * @return Positive configured value or fallback.
     */
    private static int resolvePositiveInt(int configured, int fallback) {
        return configured > 0 ? configured : fallback;
    }

    /**
     * Parses tester return values. Supports numeric score, ScoringResult, and map payloads.
     */
    @SuppressWarnings("unchecked")
    private static TesterExecutionResult parseTesterExecutionResult(
        Object runResult,
        String testerClassName
    ) throws Exception {
        if (runResult == null) {
            throw new RuntimeException(
                "runTester returned null for class " + testerClassName
            );
        }

        if (runResult instanceof Number) {
            logInfo("tester.result", "runTester returned Number score.");
            return new TesterExecutionResult(
                ((Number) runResult).doubleValue(),
                new LinkedHashMap<String, Object>()
            );
        }

        if (runResult instanceof ScoringResult) {
            logInfo("tester.result", "runTester returned ScoringResult object.");
            return new TesterExecutionResult(
                ((ScoringResult) runResult).getScore(),
                new LinkedHashMap<String, Object>()
            );
        }

        if (runResult instanceof Map) {
            Map<String, Object> resultMap = (Map<String, Object>) runResult;
            Double mapScore = parseNumeric(resultMap.get("score"));
            if (mapScore == null) {
                mapScore = parseNumeric(resultMap.get("aggregateScore"));
            }

            if (mapScore == null) {
                throw new RuntimeException(
                    "runTester map result is missing numeric score for class "
                        + testerClassName
                );
            }

            logInfo(
                "tester.result",
                "runTester returned map score="
                    + mapScore
                    + ", metadataKeys="
                    + asMap(resultMap.get("metadata")).keySet()
                    + ", hasCurrentReview="
                    + !asMap(resultMap.get("currentReview")).isEmpty()
                    + ", impactedReviews="
                    + asMapList(resultMap.get("impactedReviews")).size()
            );
            return new TesterExecutionResult(
                mapScore.doubleValue(),
                asMap(resultMap.get("metadata")),
                asMap(resultMap.get("currentReview")),
                asMapList(resultMap.get("impactedReviews"))
            );
        }

        throw new RuntimeException(
            "runTester returned unsupported type "
                + runResult.getClass().getName()
                + " for class "
                + testerClassName
        );
    }

    /**
     * Safely casts to map.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> asMap(Object value) {
        if (value instanceof Map) {
            return new LinkedHashMap<String, Object>((Map<String, Object>) value);
        }

        return new LinkedHashMap<String, Object>();
    }

    /**
     * Safely casts to list-of-map payloads.
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> asMapList(Object value) {
        List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();
        if (!(value instanceof List)) {
            return result;
        }

        for (Object entry : (List<Object>) value) {
            if (entry instanceof Map) {
                result.add(new LinkedHashMap<String, Object>((Map<String, Object>) entry));
            }
        }

        return result;
    }

    /**
     * Parses numeric values from Number or numeric String values.
     */
    private static Double parseNumeric(Object value) {
        if (value instanceof Number) {
            return ((Number) value).doubleValue();
        }

        if (value instanceof String) {
            try {
                return Double.valueOf(((String) value).trim());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }

        return null;
    }

    /**
     * Deletes a file or directory recursively and ignores cleanup failures.
     */
    private static void deletePathRecursively(Path path) {
        if (path == null) {
            return;
        }

        try {
            if (!Files.exists(path)) {
                logInfo("cleanup", "Skipping missing path: " + path);
                return;
            }

            if (Files.isDirectory(path)) {
                Files
                    .walk(path)
                    .sorted(Comparator.reverseOrder())
                    .forEach(entry -> {
                        try {
                            Files.deleteIfExists(entry);
                        } catch (IOException cleanupError) {
                            logWarn(
                                "cleanup",
                                "Failed to delete " + entry + ": " + cleanupError.getMessage()
                            );
                        }
                    });
                logInfo("cleanup", "Deleted directory tree: " + path);
                return;
            }

            Files.deleteIfExists(path);
            logInfo("cleanup", "Deleted file: " + path);
        } catch (Exception error) {
            logWarn("cleanup", "Cleanup failed for " + path + ": " + error.getMessage());
        }
    }

    /**
     * Reads all bytes from an input stream for Java 8 compatibility.
     */
    private static byte[] readAllBytes(InputStream inputStream) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int bytesRead;
        while ((bytesRead = inputStream.read(buffer)) != -1) {
            output.write(buffer, 0, bytesRead);
        }
        return output.toByteArray();
    }

    /**
     * Describes a compiled or interpreted submission command produced by the generic runner.
     */
    private static class CompiledSubmission {
        private final String executionCommand;
        private final String sourceFileName;
        private final String sourceLanguage;

        /**
         * Creates compiled submission details.
         * @param executionCommand Command string passed to MarathonController for every seed.
         * @param sourceFileName Normalized source filename used in the compile workspace.
         * @param sourceLanguage Language label written to scorer metadata.
         */
        CompiledSubmission(
            String executionCommand,
            String sourceFileName,
            String sourceLanguage
        ) {
            this.executionCommand = executionCommand;
            this.sourceFileName = sourceFileName;
            this.sourceLanguage = sourceLanguage;
        }

        /**
         * Gets the command string passed to MarathonController.
         * @return Command used to launch the compiled/interpreted submission.
         */
        String getExecutionCommand() {
            return executionCommand;
        }

        /**
         * Gets the normalized source filename used in the compile workspace.
         * @return Source filename written to scorer metadata.
         */
        String getSourceFileName() {
            return sourceFileName;
        }

        /**
         * Gets the source language label.
         * @return Language label written to scorer metadata.
         */
        String getSourceLanguage() {
            return sourceLanguage;
        }
    }

    /**
     * Java package/class information needed to compile and launch Java submissions.
     */
    private static class JavaEntryPoint {
        private final String packageName;
        private final String className;

        /**
         * Creates Java entrypoint metadata.
         * @param packageName Java package name, or blank for default package.
         * @param className Java class containing the submission main method.
         */
        JavaEntryPoint(String packageName, String className) {
            this.packageName = packageName == null ? "" : packageName;
            this.className = className;
        }

        /**
         * Gets the Java package name.
         * @return Package name, or blank for the default package.
         */
        String getPackageName() {
            return packageName;
        }

        /**
         * Gets the Java class name.
         * @return Class name used for compilation and execution.
         */
        String getClassName() {
            return className;
        }

        /**
         * Gets the Java class name including package prefix when present.
         * @return Qualified class name passed to the Java launcher.
         */
        String getQualifiedClassName() {
            if (packageName.isEmpty()) {
                return className;
            }
            return packageName + "." + className;
        }
    }

    /**
     * Callback payload posted to marathon-match API after scorer execution.
     */
    private static class ScoringCallbackRequest {
        @JsonProperty("challengeId")
        private final String challengeId;

        @JsonProperty("submissionId")
        private final String submissionId;

        @JsonProperty("score")
        private final double score;

        @JsonProperty("testPhase")
        private final String testPhase;

        @JsonProperty("reviewTypeId")
        private final String reviewTypeId;

        @JsonProperty("reviewId")
        private final String reviewId;

        @JsonProperty("scorecardId")
        private final String scorecardId;

        @JsonProperty("metadata")
        private final Map<String, Object> metadata;

        @JsonProperty("currentReview")
        private final Map<String, Object> currentReview;

        @JsonProperty("impactedReviews")
        private final List<Map<String, Object>> impactedReviews;

        ScoringCallbackRequest(
            String challengeId,
            String submissionId,
            double score,
            String testPhase,
            String reviewTypeId,
            String reviewId,
            String scorecardId,
            Map<String, Object> metadata,
            Map<String, Object> currentReview,
            List<Map<String, Object>> impactedReviews
        ) {
            this.challengeId = challengeId;
            this.submissionId = submissionId;
            this.score = score;
            this.testPhase = testPhase;
            this.reviewTypeId = reviewTypeId;
            this.reviewId = reviewId;
            this.scorecardId = scorecardId;
            this.metadata = metadata;
            this.currentReview = currentReview;
            this.impactedReviews = impactedReviews;
        }
    }

    /**
     * Request body for intermediate scorer progress updates.
     */
    private static class ScoringProgressRequest {
        @JsonProperty("challengeId")
        private final String challengeId;

        @JsonProperty("submissionId")
        private final String submissionId;

        @JsonProperty("testPhase")
        private final String testPhase;

        @JsonProperty("reviewTypeId")
        private final String reviewTypeId;

        @JsonProperty("reviewId")
        private final String reviewId;

        @JsonProperty("scorecardId")
        private final String scorecardId;

        @JsonProperty("progress")
        private final double progress;

        @JsonProperty("status")
        private final String status;

        @JsonProperty("completedTests")
        private final int completedTests;

        @JsonProperty("totalTests")
        private final int totalTests;

        @JsonProperty("failedTests")
        private final int failedTests;

        @JsonProperty("message")
        private final String message;

        @JsonProperty("metadata")
        private final Map<String, Object> metadata;

        ScoringProgressRequest(
            String challengeId,
            String submissionId,
            String testPhase,
            String reviewTypeId,
            String reviewId,
            String scorecardId,
            double progress,
            String status,
            int completedTests,
            int totalTests,
            int failedTests,
            String message,
            Map<String, Object> metadata
        ) {
            this.challengeId = challengeId;
            this.submissionId = submissionId;
            this.testPhase = testPhase;
            this.reviewTypeId = reviewTypeId;
            this.reviewId = reviewId;
            this.scorecardId = scorecardId;
            this.progress = Math.min(1.0, Math.max(0.0, progress));
            this.status = status;
            this.completedTests = Math.max(0, completedTests);
            this.totalTests = Math.max(0, totalTests);
            this.failedTests = Math.max(0, failedTests);
            this.message = message;
            this.metadata = metadata == null
                ? new LinkedHashMap<String, Object>()
                : metadata;
        }

        double getProgress() {
            return progress;
        }

        int getCompletedTests() {
            return completedTests;
        }

        int getTotalTests() {
            return totalTests;
        }

        int getFailedTests() {
            return failedTests;
        }
    }

    /**
     * Progress update emitted by the isolated tester child after each seed.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private static class IsolatedProgressUpdate {
        @JsonProperty("progress")
        private double progress;

        @JsonProperty("status")
        private String status;

        @JsonProperty("completedTests")
        private int completedTests;

        @JsonProperty("totalTests")
        private int totalTests;

        @JsonProperty("failedTests")
        private int failedTests;

        @JsonProperty("message")
        private String message;

        double getProgress() {
            return Math.min(1.0, Math.max(0.0, progress));
        }

        String getStatus() {
            if (TEST_STATUS_FAILED.equals(status)) {
                return TEST_STATUS_FAILED;
            }
            if (TEST_STATUS_SUCCESS.equals(status)) {
                return TEST_STATUS_SUCCESS;
            }
            return TEST_STATUS_IN_PROGRESS;
        }

        int getCompletedTests() {
            return Math.max(0, completedTests);
        }

        int getTotalTests() {
            return Math.max(0, totalTests);
        }

        int getFailedTests() {
            return Math.max(0, failedTests);
        }

        String getMessage() {
            return message;
        }
    }

    /**
     * Captures tester execution output consumed by callback/reporting logic.
     */
    private static class TesterExecutionResult {
        private final double score;
        private final Map<String, Object> metadata;
        private final Map<String, Object> currentReview;
        private final List<Map<String, Object>> impactedReviews;

        TesterExecutionResult(double score, Map<String, Object> metadata) {
            this(score, metadata, null, null);
        }

        TesterExecutionResult(
            double score,
            Map<String, Object> metadata,
            Map<String, Object> currentReview,
            List<Map<String, Object>> impactedReviews
        ) {
            this.score = score;
            this.metadata = metadata == null
                ? new LinkedHashMap<String, Object>()
                : metadata;
            this.currentReview = currentReview == null
                ? new LinkedHashMap<String, Object>()
                : currentReview;
            this.impactedReviews = impactedReviews == null
                ? new ArrayList<Map<String, Object>>()
                : impactedReviews;
        }

        double getScore() {
            return score;
        }

        Map<String, Object> getMetadata() {
            return metadata;
        }

        Map<String, Object> getCurrentReview() {
            return currentReview;
        }

        List<Map<String, Object>> getImpactedReviews() {
            return impactedReviews;
        }

        Map<String, Object> toSerializableMap() {
            Map<String, Object> payload = new LinkedHashMap<String, Object>();
            payload.put("score", score);
            payload.put("metadata", metadata);
            payload.put("currentReview", currentReview);
            payload.put("impactedReviews", impactedReviews);
            return payload;
        }
    }

    /**
     * Partial marathon match config response used by ECS runner bootstrap flow.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private static class MarathonMatchConfigResponse {
        @JsonProperty("id")
        private String id;

        @JsonProperty("challengeId")
        private String challengeId;

        @JsonProperty("submissionApiUrl")
        private String submissionApiUrl;

        @JsonProperty("reviewScorecardId")
        private String reviewScorecardId;

        @JsonProperty("testerId")
        private String testerId;

        @JsonProperty("testTimeout")
        private Integer testTimeout;

        @JsonProperty("compileTimeout")
        private Integer compileTimeout;

        public String getId() {
            return id;
        }

        public String getChallengeIdOrId() {
            if (challengeId == null || challengeId.trim().isEmpty()) {
                return id;
            }
            return challengeId;
        }

        public String getSubmissionApiUrl() {
            return submissionApiUrl;
        }

        public String getReviewScorecardId() {
            return reviewScorecardId;
        }

        public String getTesterId() {
            return testerId;
        }

        public int getTestTimeout() {
            return testTimeout == null ? 0 : testTimeout.intValue();
        }

        public int getCompileTimeout() {
            return compileTimeout == null ? 0 : compileTimeout.intValue();
        }
    }

    /**
     * Partial tester response used by ECS runner to discover tester class name.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private static class TesterResponse {
        @JsonProperty("id")
        private String id;

        @JsonProperty("name")
        private String name;

        @JsonProperty("className")
        private String className;

        @JsonProperty("compilationStatus")
        private String compilationStatus;

        public String getId() {
            return id;
        }

        public String getName() {
            return name;
        }

        public String getClassName() {
            return className;
        }

        public String getCompilationStatus() {
            return compilationStatus;
        }
    }
}
