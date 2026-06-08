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
import java.io.OutputStream;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.management.ManagementFactory;
import java.net.URL;
import java.net.URLClassLoader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.DirectoryStream;
import java.nio.file.FileVisitResult;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.nio.file.SimpleFileVisitor;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileAttribute;
import java.nio.file.attribute.GroupPrincipal;
import java.nio.file.attribute.PosixFileAttributeView;
import java.nio.file.attribute.PosixFilePermission;
import java.nio.file.attribute.PosixFilePermissions;
import java.nio.file.attribute.UserPrincipal;
import java.nio.file.attribute.UserPrincipalLookupService;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.Comparator;
import java.util.EnumSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
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
    private static final int STREAM_COPY_BUFFER_SIZE = 8192;
    private static final int CHILD_OUTPUT_TAIL_LIMIT = 4000;
    private static final long DEFAULT_MAX_OUTPUT_BYTES = 10_000_000L;
    private static final String MAX_OUTPUT_BYTES_PROPERTY = "mm.runner.maxOutputBytes";
    private static final String MAX_OUTPUT_BYTES_ENV = "MM_RUNNER_MAX_OUTPUT_BYTES";
    private static final long MAX_OUTPUT_BYTES = resolveMaxOutputBytes();
    private static final int HTTP_UNAUTHORIZED = 401;
    private static final long TOKEN_REFRESH_SKEW_SECONDS = 60L;
    private static final String ISOLATED_TESTER_CHILD_MODE = "--isolated-tester-run";
    private static final String ISOLATED_TESTER_RESULT_MARKER =
        "__MM_ISOLATED_TESTER_RESULT__:";
    private static final String ISOLATED_TESTER_PROGRESS_MARKER =
        "__MM_ISOLATED_TESTER_PROGRESS__:";
    private static final String RUNNER_ISOLATION_WRAPPER_PATH =
        "/usr/local/bin/mm-runner-isolate";
    private static final String SCORER_ISOLATION_WRAPPER_PATH =
        "/usr/local/bin/mm-scorer-isolate";
    private static final String RUNNER_EXECUTION_USER = "runner";
    private static final String RUNNER_EXECUTION_GROUP = "runner";
    private static final String SCORER_EXECUTION_USER = "scorer";
    private static final List<String> SCORER_WRITABLE_STATE_DIRS = Arrays.asList(
        "/tmp",
        "/var/tmp",
        "/dev/shm",
        "/home/scorer"
    );
    private static final String TEST_STATUS_IN_PROGRESS = "IN PROGRESS";
    private static final String TEST_STATUS_SUCCESS = "SUCCESS";
    private static final String TEST_STATUS_FAILED = "FAILED";
    private static final int DEFAULT_TEST_TIMEOUT_MS = 10000;
    private static final int DEFAULT_COMPILE_TIMEOUT_MS = 30000;
    private static final String GENERIC_SOLUTION_BASE_NAME = "Solution";
    private static final String JAVA_SUBMISSION_RELEASE = "11";
    private static final String CXX_MARCH_FLAG = "-march=x86-64";
    private static final String CXX_MTUNE_FLAG = "-mtune=generic";
    private static final double FAILED_TEST_SCORE = -1.0;
    private static final double MAX_SCORE_VALUE = Long.MAX_VALUE;
    private static final String MAX_SCORE_VALUE_LABEL = Long.toString(Long.MAX_VALUE);
    private static final List<String> SUPPORTED_SOURCE_EXTENSIONS = Arrays.asList(
        ".cpp",
        ".java",
        ".py",
        ".cs",
        ".cs_net10",
        ".cs_net7",
        ".rs"
    );
    private static final String SUPPORTED_SOURCE_EXTENSIONS_TEXT =
        String.join(", ", SUPPORTED_SOURCE_EXTENSIONS);
    private static final String NO_SUPPORTED_SOURCE_ERROR =
        "No supported source file found.";
    private static final Pattern JAVA_PACKAGE_PATTERN = Pattern.compile(
        "(?m)^\\s*package\\s+([A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*)\\s*;"
    );
    private static final Pattern JAVA_PUBLIC_CLASS_PATTERN = Pattern.compile(
        "\\bpublic\\s+(?:final\\s+|abstract\\s+)?class\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\b"
    );
    private static final Pattern JAVA_CLASS_PATTERN = Pattern.compile(
        "\\bclass\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\b"
    );
    private static final String JAVA_STARTUP_CHECK_CLASS_NAME =
        "com.topcoder.runner.startupcheck.JavaStartupCheck";
    private static final String JAVA_STARTUP_CHECK_SOURCE =
        "package com.topcoder.runner.startupcheck;\n"
            + "\n"
            + "public final class JavaStartupCheck {\n"
            + "    private JavaStartupCheck() {\n"
            + "    }\n"
            + "\n"
            + "    public static void main(String[] args) throws Exception {\n"
            + "        if (args.length != 1 || args[0].trim().isEmpty()) {\n"
            + "            throw new IllegalArgumentException(\"Submitted class name is required.\");\n"
            + "        }\n"
            + "        Class.forName(args[0], true, Thread.currentThread().getContextClassLoader());\n"
            + "    }\n"
            + "}\n";
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
    private static final ThreadLocal<List<Path>> DEFERRED_ISOLATED_CLEANUP_PATHS =
        new ThreadLocal<List<Path>>();

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
        AccessTokenProvider accessTokenProvider = null;
        String marathonMatchBaseUrl = null;
        String reviewTypeId = null;
        String scorecardId = null;
        String submissionApiUrl = null;

        try {
            challengeId = getRequiredEnv("TESTER_CONFIG_ID");
            submissionId = getRequiredEnv("SUBMISSION_ID");
            accessToken = getRequiredEnv("ACCESS_TOKEN");
            accessTokenProvider = buildAccessTokenProvider(accessToken);
            boolean debugLogAccessToken = isTruthyEnv("DEBUG_LOG_ACCESS_TOKEN");
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
            requireTrustedRunnerProcess();

            if (debugLogAccessToken) {
                logAccessTokenDebug(accessToken);
            }

            try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
                logInfo(
                    "api.fetch-config",
                    "Requesting challenge config for challengeId=" + challengeId
                );
                MarathonMatchConfigResponse config = fetchJson(
                    httpClient,
                    marathonMatchBaseUrl + "/challenge/" + challengeId,
                    accessTokenProvider,
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
                    accessTokenProvider
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
                    accessTokenProvider,
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
                    accessTokenProvider.getToken(httpClient)
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
                        accessTokenProvider,
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
                        accessTokenProvider,
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
                    accessTokenProvider,
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
                    accessTokenProvider,
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
                accessTokenProvider,
                submissionId,
                testPhase,
                submissionDir
            );
            postFailureProgressSafely(
                challengeId,
                submissionId,
                testPhase,
                reviewId,
                accessTokenProvider,
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
        List<Path> deferredCleanupPaths = new ArrayList<Path>();
        DEFERRED_ISOLATED_CLEANUP_PATHS.set(deferredCleanupPaths);
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

            ScorerConfig scorerConfig = loadAndDeleteIsolatedScorerConfig(
                scorerConfigPath
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
        } finally {
            cleanupDeferredIsolatedChildPaths(deferredCleanupPaths);
            DEFERRED_ISOLATED_CLEANUP_PATHS.remove();
        }
    }

    /**
     * Loads the short-lived scorer config handoff file and removes it before any
     * tester or submitted solution code can execute.
     *
     * @param scorerConfigPath Runner-owned scorer config file written by the parent runner.
     * @return Parsed scorer configuration for the isolated child JVM.
     * @throws IOException When the config cannot be read or deleted.
     */
    private static ScorerConfig loadAndDeleteIsolatedScorerConfig(Path scorerConfigPath)
        throws IOException {
        ScorerConfig scorerConfig = OBJECT_MAPPER.readValue(
            scorerConfigPath.toFile(),
            ScorerConfig.class
        );
        Files.delete(scorerConfigPath);
        logInfo(
            "tester.isolated",
            "Deleted isolated scorer config before tester execution."
        );
        return scorerConfig;
    }

    /**
     * Prepares extracted submission/tester inputs so the isolated runner user can
     * compile, execute, and write artifacts without inheriting trusted env state.
     */
    private static void prepareIsolatedExecutionInputs(
        Path submissionDir,
        Path testerJarPath
    ) throws Exception {
        requireTrustedRunnerProcess();
        if (submissionDir == null || !Files.isDirectory(submissionDir)) {
            throw new IOException("Submission directory is not available: " + submissionDir);
        }
        grantRunnerWorkspaceAccess(submissionDir);
        secureRunnerOnlyFile(testerJarPath);
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
        AccessTokenProvider accessTokenProvider,
        String reviewTypeId,
        String reviewId,
        String scorecardId
    ) throws Exception {
        Path scorerConfigPath = null;
        try {
            scorerConfigPath = Files.createTempFile("mm-isolated-scorer-", ".json");
            OBJECT_MAPPER.writeValue(scorerConfigPath.toFile(), scorerConfig);
            secureRunnerOnlyFile(scorerConfigPath);

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
            grantRunnerWorkspaceAccess(artifactsDir);
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
                                accessTokenProvider,
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
     * @param accessTokenProvider Refresh-capable bearer token provider.
     * @param submissionId Submission ID.
     * @param testPhase Scoring phase.
     * @param submissionDir Extracted submission directory.
     */
    private static void uploadFailureArtifactsSafely(
        String submissionApiUrl,
        AccessTokenProvider accessTokenProvider,
        String submissionId,
        String testPhase,
        Path submissionDir
    ) {
        if (
            isBlank(submissionApiUrl)
                || accessTokenProvider == null
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
                accessTokenProvider,
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
        command.add(RUNNER_ISOLATION_WRAPPER_PATH);
        command.add(getCurrentJavaBinaryPath());
        command.addAll(getIsolatedChildJvmArguments());
        command.add("-D" + MAX_OUTPUT_BYTES_PROPERTY + "=" + MAX_OUTPUT_BYTES);
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
     * Fails fast when the trusted parent process is not running as root.
     *
     * <p>The trusted parent owns bootstrap, artifact upload, and filesystem
     * preparation. The child JVM runs as the unprivileged {@code runner} user,
     * and generic submitted solution commands run as the separate
     * unprivileged {@code scorer} user.
     *
     * @throws IllegalStateException When the runner process is not root.
     */
    private static void requireTrustedRunnerProcess() {
        String currentUser = System.getProperty("user.name", "");
        if (!"root".equals(currentUser)) {
            throw new IllegalStateException(
                "Runner must start as root so submitted solution commands can drop to "
                    + SCORER_EXECUTION_USER
                    + ". Current user: "
                    + currentUser
            );
        }
    }

    /**
     * Restricts a sensitive file to read-only access by the isolated Java runner user.
     *
     * <p>This is used for downloaded tester JARs and serialized scorer config.
     * The submitted solution process runs as {@code scorer}, so runner-owned
     * read-only permissions prevent shell probes from reading or modifying
     * those files even when they can guess the path.
     *
     * @param path Sensitive regular file to restrict.
     * @throws IOException When permissions cannot be applied on POSIX filesystems.
     */
    private static void secureRunnerOnlyFile(Path path) throws IOException {
        setRunnerOnlyPermissions(path);
    }

    /**
     * Applies runner-owned POSIX permissions to a sensitive runner file.
     *
     * @param path Sensitive regular file to restrict.
     * @throws IOException When permissions cannot be applied on POSIX filesystems.
     */
    private static void setRunnerOnlyPermissions(Path path) throws IOException {
        if (path == null || !Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }

        try {
            setRunnerOwnerAndGroup(path);
            Files.setPosixFilePermissions(
                path,
                EnumSet.of(PosixFilePermission.OWNER_READ)
            );
        } catch (UnsupportedOperationException ignored) {
            logWarn(
                "filesystem.permissions",
                "POSIX permissions are not supported for " + path
            );
        }
    }

    /**
     * Makes a runner workspace writable by the isolated tester JVM without
     * granting the lower-privilege scorer user direct access to runner-only files.
     *
     * @param path Workspace directory or file prepared by the trusted parent.
     * @throws IOException When walking the workspace fails.
     */
    private static void grantRunnerWorkspaceAccess(Path path) throws IOException {
        if (path == null || !Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }

        try (java.util.stream.Stream<Path> stream = Files.walk(path)) {
            java.util.Iterator<Path> iterator = stream.iterator();
            while (iterator.hasNext()) {
                applyRunnerWorkspacePermissions(iterator.next());
            }
        }
    }

    /**
     * Applies runner ownership and owner-only permissions to one workspace entry.
     *
     * @param path Workspace entry to update.
     */
    private static void applyRunnerWorkspacePermissions(Path path) {
        try {
            setRunnerOwnerAndGroup(path);
            if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.setPosixFilePermissions(
                    path,
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE
                    )
                );
            } else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.setPosixFilePermissions(
                    path,
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE
                    )
                );
            }
        } catch (UnsupportedOperationException ignored) {
            logWarn(
                "filesystem.permissions",
                "POSIX ownership or permissions are not supported for " + path
            );
        } catch (IOException error) {
            throw new RuntimeException(
                "Failed to update runner permissions for "
                    + path
                    + ": "
                    + error.getMessage(),
                error
            );
        }
    }

    /**
     * Changes one path to the isolated runner user and group.
     *
     * @param path File or directory to chown without following symlinks.
     * @throws IOException When ownership cannot be applied.
     */
    private static void setRunnerOwnerAndGroup(Path path) throws IOException {
        PosixFileAttributeView view = Files.getFileAttributeView(
            path,
            PosixFileAttributeView.class,
            LinkOption.NOFOLLOW_LINKS
        );
        if (view == null) {
            throw new UnsupportedOperationException(
                "POSIX attributes are not available for " + path
            );
        }

        UserPrincipalLookupService lookupService = path
            .getFileSystem()
            .getUserPrincipalLookupService();
        UserPrincipal runnerUser = lookupService.lookupPrincipalByName(
            RUNNER_EXECUTION_USER
        );
        GroupPrincipal runnerGroup = lookupService.lookupPrincipalByGroupName(
            RUNNER_EXECUTION_GROUP
        );
        view.setOwner(runnerUser);
        view.setGroup(runnerGroup);
    }

    /**
     * Makes the compile workspace readable and executable by the lower-privilege
     * scorer user without exposing runner-only files outside that workspace.
     *
     * @param path Compile workspace directory or file prepared by the runner.
     * @throws IOException When walking the workspace fails.
     */
    private static void grantScorerReadExecuteAccess(Path path) throws IOException {
        if (path == null || !Files.exists(path, LinkOption.NOFOLLOW_LINKS)) {
            return;
        }

        try (java.util.stream.Stream<Path> stream = Files.walk(path)) {
            java.util.Iterator<Path> iterator = stream.iterator();
            while (iterator.hasNext()) {
                applyScorerAccessiblePermissions(iterator.next());
            }
        }
    }

    /**
     * Applies read/execute permissions needed for the scorer user to launch one
     * compiled or interpreted submission file.
     *
     * @param path Workspace entry to make accessible.
     */
    private static void applyScorerAccessiblePermissions(Path path) {
        try {
            if (Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.setPosixFilePermissions(
                    path,
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE,
                        PosixFilePermission.GROUP_READ,
                        PosixFilePermission.GROUP_EXECUTE,
                        PosixFilePermission.OTHERS_READ,
                        PosixFilePermission.OTHERS_EXECUTE
                    )
                );
            } else if (Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS)) {
                Files.setPosixFilePermissions(
                    path,
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE,
                        PosixFilePermission.OWNER_EXECUTE,
                        PosixFilePermission.GROUP_READ,
                        PosixFilePermission.GROUP_EXECUTE,
                        PosixFilePermission.OTHERS_READ,
                        PosixFilePermission.OTHERS_EXECUTE
                    )
                );
            }
        } catch (UnsupportedOperationException ignored) {
            logWarn(
                "filesystem.permissions",
                "POSIX permissions are not supported for " + path
            );
        } catch (IOException error) {
            throw new RuntimeException(
                "Failed to update scorer permissions for "
                    + path
                    + ": "
                    + error.getMessage(),
                error
            );
        }
    }

    /**
     * Cleans up scorer-owned processes after isolated execution.
     *
     * <p>The scorer helper supervises generic submitted solution process groups,
     * but this cleanup also handles custom tester paths or detached descendants
     * that survive until the isolated child JVM exits.
     */
    private static void killLingeringIsolatedProcesses() {
        killLingeringIsolatedProcesses(false);
    }

    /**
     * Cleans up scorer-owned processes after isolated execution.
     *
     * @param quietWhenNone Suppresses the normal "none found" log for per-test cleanup.
     * @return {@code true} when at least one lingering scorer process was killed.
     */
    private static boolean killLingeringIsolatedProcesses(boolean quietWhenNone) {
        if (!"root".equals(System.getProperty("user.name", ""))) {
            if (!quietWhenNone) {
                logInfo(
                    "tester.isolated",
                    "Skipping scorer process cleanup from non-root runner. User="
                        + System.getProperty("user.name", "")
                        + ", target="
                        + SCORER_EXECUTION_USER
                );
            }
            return false;
        }

        try {
            ProcessBuilder processBuilder = new ProcessBuilder(
                "pkill",
                "-KILL",
                "-u",
                SCORER_EXECUTION_USER
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
                        + SCORER_EXECUTION_USER
                        + "."
                );
                return true;
            }

            if (exitCode == 1) {
                if (!quietWhenNone) {
                    logInfo(
                        "tester.isolated",
                        "No lingering processes found for user "
                            + SCORER_EXECUTION_USER
                            + "."
                    );
                }
                return false;
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
        return false;
    }

    /**
     * Removes untrusted scorer process and filesystem state around one seed execution.
     *
     * <p>Standard Marathon testers run each seed as a separate submitted solution process, but
     * those processes share container filesystem locations such as {@code /tmp}. Resetting
     * scorer-owned writable entries before and after every seed prevents a submission from
     * passing information to later seeds through files it created.
     *
     * @param boundary Text describing whether cleanup is running before or after the test case.
     * @param testCaseNumber Member-visible ordinal for the seed being isolated.
     */
    private static void resetScorerWritableStateForTestCase(
        String boundary,
        int testCaseNumber
    ) {
        killLingeringIsolatedProcesses(true);
        int deletedEntries = deleteScorerOwnedWritableStateEntries();
        if (deletedEntries > 0) {
            logInfo(
                "tester.tmp-isolation",
                "Deleted "
                    + deletedEntries
                    + " scorer-owned writable entries "
                    + boundary
                    + " testCase="
                    + testCaseNumber
            );
        }
    }

    /**
     * Deletes top-level entries owned by the low-privilege scorer user from writable locations.
     *
     * <p>Trusted runner files are not owned by the scorer user and are not removed. Each selected
     * entry is deleted with symlink-safe traversal so a malicious submission cannot redirect
     * cleanup outside the selected writable directory.
     *
     * @return Number of top-level scorer-owned entries deleted.
     */
    private static int deleteScorerOwnedWritableStateEntries() {
        int deletedEntries = 0;
        for (String directory : SCORER_WRITABLE_STATE_DIRS) {
            deletedEntries += deleteScorerOwnedDirectoryEntries(Paths.get(directory));
        }
        return deletedEntries;
    }

    /**
     * Deletes top-level entries owned by scorer under one writable directory.
     *
     * @param directory Writable directory to reset.
     * @return Number of top-level scorer-owned entries deleted.
     */
    private static int deleteScorerOwnedDirectoryEntries(Path directory) {
        if (!Files.isDirectory(directory, LinkOption.NOFOLLOW_LINKS)) {
            return 0;
        }

        int deletedEntries = 0;
        try (DirectoryStream<Path> stream = Files.newDirectoryStream(directory)) {
            for (Path entry : stream) {
                if (!isScorerOwnedPath(entry)) {
                    continue;
                }

                try {
                    deleteUntrustedPathRecursively(entry);
                    deletedEntries += 1;
                } catch (NoSuchFileException ignored) {
                    // Entry disappeared between listing and deletion.
                } catch (IOException cleanupError) {
                    logWarn(
                        "tester.tmp-isolation",
                        "Failed to delete scorer-owned entry "
                            + entry
                            + ": "
                            + cleanupError.getMessage()
                    );
                }
            }
        } catch (IOException error) {
            logWarn(
                "tester.tmp-isolation",
                "Failed to list scorer-owned entries under "
                    + directory
                    + ": "
                    + error.getMessage()
            );
        }

        return deletedEntries;
    }

    /**
     * Checks ownership without following symlinks.
     *
     * @param path Candidate writable-state entry.
     * @return {@code true} when the entry is owned by the scorer user.
     */
    private static boolean isScorerOwnedPath(Path path) {
        try {
            return SCORER_EXECUTION_USER.equals(
                Files.getOwner(path, LinkOption.NOFOLLOW_LINKS).getName()
            );
        } catch (IOException error) {
            logWarn(
                "tester.tmp-isolation",
                "Unable to read owner for writable entry "
                    + path
                    + ": "
                    + error.getMessage()
            );
            return false;
        }
    }

    /**
     * Deletes an untrusted path tree without following symbolic links.
     *
     * @param path Top-level scorer-owned writable-state entry to remove.
     * @throws IOException When deletion fails.
     */
    private static void deleteUntrustedPathRecursively(Path path) throws IOException {
        Files.walkFileTree(
            path,
            new SimpleFileVisitor<Path>() {
                @Override
                public FileVisitResult visitFile(
                    Path file,
                    BasicFileAttributes attributes
                ) throws IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult postVisitDirectory(
                    Path directory,
                    IOException error
                ) throws IOException {
                    if (error != null) {
                        throw error;
                    }

                    Files.deleteIfExists(directory);
                    return FileVisitResult.CONTINUE;
                }

                @Override
                public FileVisitResult visitFileFailed(
                    Path file,
                    IOException error
                ) throws IOException {
                    Files.deleteIfExists(file);
                    return FileVisitResult.CONTINUE;
                }
            }
        );
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
        if (artifactPath == null || !isNonSymlinkRegularFile(artifactPath)) {
            logInfo(
                "artifacts.preview",
                "No " + description + " file found at artifacts/" + relativePath
            );
            return;
        }

        try {
            byte[] contentBytes = readRegularFileBytesNoFollow(artifactPath);
            String content = new String(contentBytes, StandardCharsets.UTF_8);
            logInfo(
                "artifacts.preview",
                description
                    + " path="
                    + artifactPath
                    + ", sizeBytes="
                    + contentBytes.length
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
     * Builds the parent-runner token provider from ECS environment overrides.
     *
     * <p>The initial {@code ACCESS_TOKEN} keeps existing task launches working.
     * Auth0 settings allow long-running scorer tasks to refresh M2M tokens before
     * expiry or after a 401 response.
     */
    private static AccessTokenProvider buildAccessTokenProvider(String initialAccessToken) {
        return new AccessTokenProvider(
            initialAccessToken,
            getOptionalEnv("AUTH0_URL", "http://localhost:4000/oauth/token"),
            getOptionalEnv("AUTH0_AUDIENCE", "https://m2m.topcoder-dev.com/"),
            getOptionalEnv("AUTH0_PROXY_SERVER_URL", ""),
            getOptionalEnv("AUTH0_CLIENT_ID", ""),
            getOptionalEnv("AUTH0_CLIENT_SECRET", "")
        );
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
     * Resolves the maximum output bytes accepted by the runner.
     *
     * <p>The JVM property is checked first so the trusted parent can pass the
     * same limit into the scrubbed isolated child. The environment variable is
     * kept for ECS task configuration without requiring custom Java options.
     *
     * @return Positive byte limit for generated output and artifact content.
     */
    private static long resolveMaxOutputBytes() {
        String configured = System.getProperty(MAX_OUTPUT_BYTES_PROPERTY);
        if (configured == null || configured.trim().isEmpty()) {
            configured = System.getenv(MAX_OUTPUT_BYTES_ENV);
        }

        if (configured == null || configured.trim().isEmpty()) {
            return DEFAULT_MAX_OUTPUT_BYTES;
        }

        try {
            long parsed = Long.parseLong(configured.trim());
            return parsed > 0L ? parsed : DEFAULT_MAX_OUTPUT_BYTES;
        } catch (NumberFormatException ignored) {
            return DEFAULT_MAX_OUTPUT_BYTES;
        }
    }

    /**
     * Appends generated public output while enforcing the configured byte cap.
     *
     * @param target Destination buffer for {@code output.txt}.
     * @param value Text to append.
     * @param currentBytes UTF-8 bytes already appended.
     * @param outputName Human-readable output label for errors.
     * @return Updated UTF-8 byte count after appending.
     */
    private static long appendLimitedOutput(
        StringBuilder target,
        String value,
        long currentBytes,
        String outputName
    ) {
        if (value == null || value.isEmpty()) {
            return currentBytes;
        }

        long nextBytes = addOutputBytesWithLimit(
            currentBytes,
            value.getBytes(StandardCharsets.UTF_8).length,
            outputName
        );
        target.append(value);
        return nextBytes;
    }

    /**
     * Adds output bytes to a running total and fails when the cap is exceeded.
     *
     * @param currentBytes Current byte total.
     * @param additionalBytes Bytes being added.
     * @param outputName Human-readable output label for errors.
     * @return Updated byte total.
     */
    private static long addOutputBytesWithLimit(
        long currentBytes,
        long additionalBytes,
        String outputName
    ) {
        long nextBytes = Long.MAX_VALUE - currentBytes < additionalBytes
            ? Long.MAX_VALUE
            : currentBytes + additionalBytes;
        enforceOutputByteLimit(nextBytes, outputName);
        return nextBytes;
    }

    /**
     * Fails the runner when generated output or artifacts exceed the configured limit.
     *
     * @param sizeBytes Output size in bytes.
     * @param outputName Human-readable output label for errors.
     */
    private static void enforceOutputByteLimit(long sizeBytes, String outputName) {
        if (sizeBytes <= MAX_OUTPUT_BYTES) {
            return;
        }

        throw new RuntimeException(
            "Output size limit exceeded for "
                + outputName
                + ": "
                + sizeBytes
                + " bytes exceeds maximum "
                + MAX_OUTPUT_BYTES
                + " bytes."
        );
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
     * Emits redacted token debugging information for auth troubleshooting.
     * @param accessToken Access token provided to the ECS runner.
     */
    private static void logAccessTokenDebug(String accessToken) {
        logInfo("auth.token", "ACCESS_TOKEN length=" + accessToken.length());
        logInfo(
            "auth.token",
            "ACCESS_TOKEN value=" + redactToken(accessToken)
        );
    }

    /**
     * Produces a token redaction marker that exposes no credential characters.
     * @param token Raw token value.
     * @returns Redaction marker with token length only.
     */
    private static String redactToken(String token) {
        if (token == null || token.isEmpty()) {
            return "<empty>";
        }

        return "<redacted-length-" + token.length() + ">";
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
        AccessTokenProvider accessTokenProvider,
        Class<T> responseType
    ) throws Exception {
        logInfo(
            "http.get.json",
            "GET " + url + " (responseType=" + responseType.getSimpleName() + ")"
        );
        String body = executeGetAsString(httpClient, url, accessTokenProvider);
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
        AccessTokenProvider accessTokenProvider
    ) throws Exception {
        for (int attempt = 1; attempt <= 2; attempt++) {
            HttpGet request = new HttpGet(url);
            request.setHeader(
                "Authorization",
                "Bearer " + accessTokenProvider.getToken(httpClient)
            );
            logInfo(
                "http.get.binary",
                "GET " + url + " with Authorization Bearer token"
            );

            boolean retryWithFreshToken = false;
            try (CloseableHttpResponse response = httpClient.execute(request)) {
                int statusCode = response.getStatusLine().getStatusCode();
                logInfo("http.get.binary", "GET " + url + " returned HTTP " + statusCode);
                if (statusCode < 200 || statusCode >= 300) {
                    String responseBody = response.getEntity() == null
                        ? ""
                        : EntityUtils.toString(
                            response.getEntity(),
                            StandardCharsets.UTF_8
                        );

                    if (
                        shouldRetryWithRefreshedToken(
                            statusCode,
                            attempt,
                            accessTokenProvider
                        )
                    ) {
                        logWarn(
                            "http.get.binary",
                            "GET "
                                + url
                                + " returned HTTP 401; refreshing M2M token and retrying once, body="
                                + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
                        );
                        retryWithFreshToken = true;
                    } else {
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
                            "GET "
                                + url
                                + " failed: HTTP "
                                + statusCode
                                + " - "
                                + responseBody
                        );
                    }
                } else {
                    if (response.getEntity() == null) {
                        logError(
                            "http.get.binary",
                            "GET " + url + " returned empty response body",
                            null
                        );
                        throw new RuntimeException(
                            "GET " + url + " returned empty response body."
                        );
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

            if (retryWithFreshToken) {
                refreshAccessTokenAfterUnauthorized(
                    accessTokenProvider,
                    httpClient,
                    "GET " + url
                );
            }
        }

        throw new RuntimeException("GET " + url + " failed after token refresh retry.");
    }

    /**
     * Executes an authorized GET request and returns response body as UTF-8 text.
     */
    private static String executeGetAsString(
        CloseableHttpClient httpClient,
        String url,
        AccessTokenProvider accessTokenProvider
    ) throws Exception {
        for (int attempt = 1; attempt <= 2; attempt++) {
            HttpGet request = new HttpGet(url);
            request.setHeader(
                "Authorization",
                "Bearer " + accessTokenProvider.getToken(httpClient)
            );
            request.setHeader("Content-Type", "application/json");
            logInfo("http.get", "GET " + url + " (Content-Type: application/json)");

            boolean retryWithFreshToken = false;
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
                    if (
                        shouldRetryWithRefreshedToken(
                            statusCode,
                            attempt,
                            accessTokenProvider
                        )
                    ) {
                        logWarn(
                            "http.get",
                            "GET "
                                + url
                                + " returned HTTP 401; refreshing M2M token and retrying once."
                        );
                        retryWithFreshToken = true;
                    } else {
                        throw new RuntimeException(
                            "GET "
                                + url
                                + " failed: HTTP "
                                + statusCode
                                + " - "
                                + responseBody
                        );
                    }
                } else {
                    return responseBody;
                }
            }

            if (retryWithFreshToken) {
                refreshAccessTokenAfterUnauthorized(
                    accessTokenProvider,
                    httpClient,
                    "GET " + url
                );
            }
        }

        throw new RuntimeException("GET " + url + " failed after token refresh retry.");
    }

    /**
     * Posts scoring callback payload to marathon-match API.
     */
    private static void postScoringCallback(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        AccessTokenProvider accessTokenProvider,
        ScoringCallbackRequest callbackRequest
    ) throws Exception {
        String url = marathonMatchBaseUrl + "/internal/scoring-results";
        String payload = OBJECT_MAPPER.writeValueAsString(callbackRequest);

        for (int attempt = 1; attempt <= 2; attempt++) {
            HttpPost request = new HttpPost(url);
            request.setHeader(
                "Authorization",
                "Bearer " + accessTokenProvider.getToken(httpClient)
            );
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

            boolean retryWithFreshToken = false;
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
                    if (
                        shouldRetryWithRefreshedToken(
                            statusCode,
                            attempt,
                            accessTokenProvider
                        )
                    ) {
                        logWarn(
                            "http.post.callback",
                            "POST "
                                + url
                                + " returned HTTP 401; refreshing M2M token and retrying once."
                        );
                        retryWithFreshToken = true;
                    } else {
                        throw new RuntimeException(
                            "POST "
                                + url
                                + " failed: HTTP "
                                + statusCode
                                + " - "
                                + responseBody
                        );
                    }
                } else {
                    return;
                }
            }

            if (retryWithFreshToken) {
                refreshAccessTokenAfterUnauthorized(
                    accessTokenProvider,
                    httpClient,
                    "POST " + url
                );
            }
        }

        throw new RuntimeException("POST " + url + " failed after token refresh retry.");
    }

    /**
     * Posts a scoring progress payload to marathon-match API without failing the runner.
     *
     * @param httpClient Trusted parent HTTP client.
     * @param marathonMatchBaseUrl Marathon Match API base URL.
     * @param accessTokenProvider Refresh-capable bearer token provider.
     * @param progressRequest Progress payload to persist in review summation metadata.
     */
    private static void postScoringProgressSafely(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        AccessTokenProvider accessTokenProvider,
        ScoringProgressRequest progressRequest
    ) {
        rememberScoringProgress(progressRequest);

        try {
            postScoringProgress(
                httpClient,
                marathonMatchBaseUrl,
                accessTokenProvider,
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
     * @param accessTokenProvider Refresh-capable bearer token provider.
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
        AccessTokenProvider accessTokenProvider,
        String marathonMatchBaseUrl,
        String reviewTypeId,
        String scorecardId,
        String message
    ) {
        if (
            !isProgressTrackedPhase(testPhase)
                || accessTokenProvider == null
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
                accessTokenProvider,
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
     * @param accessTokenProvider Refresh-capable bearer token provider.
     * @param progressRequest Progress payload to persist in review summation metadata.
     * @throws Exception When the API rejects the progress update.
     */
    private static void postScoringProgress(
        CloseableHttpClient httpClient,
        String marathonMatchBaseUrl,
        AccessTokenProvider accessTokenProvider,
        ScoringProgressRequest progressRequest
    ) throws Exception {
        String url = marathonMatchBaseUrl + "/internal/scoring-progress";
        String payload = OBJECT_MAPPER.writeValueAsString(progressRequest);

        for (int attempt = 1; attempt <= 2; attempt++) {
            HttpPost request = new HttpPost(url);
            request.setHeader(
                "Authorization",
                "Bearer " + accessTokenProvider.getToken(httpClient)
            );
            request.setHeader("Content-Type", "application/json");
            request.setEntity(new StringEntity(payload, StandardCharsets.UTF_8));
            logInfo(
                "http.post.progress",
                "POST " + url + " payloadChars=" + payload.length()
            );

            boolean retryWithFreshToken = false;
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
                    if (
                        shouldRetryWithRefreshedToken(
                            statusCode,
                            attempt,
                            accessTokenProvider
                        )
                    ) {
                        logWarn(
                            "http.post.progress",
                            "POST "
                                + url
                                + " returned HTTP 401; refreshing M2M token and retrying once."
                        );
                        retryWithFreshToken = true;
                    } else {
                        throw new RuntimeException(
                            "POST "
                                + url
                                + " failed: HTTP "
                                + statusCode
                                + " - "
                                + responseBody
                        );
                    }
                } else {
                    return;
                }
            }

            if (retryWithFreshToken) {
                refreshAccessTokenAfterUnauthorized(
                    accessTokenProvider,
                    httpClient,
                    "POST " + url
                );
            }
        }

        throw new RuntimeException("POST " + url + " failed after token refresh retry.");
    }

    /**
     * Determines whether an unauthorized response should trigger a single forced
     * M2M token refresh and request retry.
     */
    private static boolean shouldRetryWithRefreshedToken(
        int statusCode,
        int attempt,
        AccessTokenProvider accessTokenProvider
    ) {
        return statusCode == HTTP_UNAUTHORIZED
            && attempt == 1
            && accessTokenProvider != null
            && accessTokenProvider.canRefresh();
    }

    /**
     * Forces a new M2M token after a 401 before retrying the original request.
     */
    private static void refreshAccessTokenAfterUnauthorized(
        AccessTokenProvider accessTokenProvider,
        CloseableHttpClient httpClient,
        String requestDescription
    ) throws Exception {
        accessTokenProvider.refreshToken(
            httpClient,
            "HTTP 401 from " + requestDescription
        );
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
     * Any existing {@code reviews.json} path is replaced with the trusted parent
     * payload because this filename is reserved for canonical internal reviews.
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

        Map<String, Object> payload = buildInternalReviewArtifactPayload(
            submissionId,
            testPhase,
            reviewTypeId,
            scorecardId,
            testerExecution,
            callbackMetadata
        );

        Path tempReviewsJsonPath = Files.createTempFile(
            privateArtifactsDir,
            ".reviews-",
            ".json"
        );
        try {
            OBJECT_MAPPER
                .writerWithDefaultPrettyPrinter()
                .writeValue(tempReviewsJsonPath.toFile(), payload);
            replaceReservedInternalReviewArtifact(tempReviewsJsonPath, reviewsJsonPath);
        } finally {
            Files.deleteIfExists(tempReviewsJsonPath);
        }

        logInfo(
            "artifacts.internal-review",
            "Wrote internal reviews artifact " + reviewsJsonPath
        );
    }

    /**
     * Replaces the reserved internal reviews artifact with the trusted payload.
     *
     * <p>Submitted code can write inside {@code artifacts/private}, so the parent
     * must not append to or preserve an existing path at this reserved filename.
     * Symlinks are replaced by the move operation, and real directories are
     * removed without following nested symlinks before the final replace.
     *
     * @param sourcePath Parent-created temporary file containing canonical JSON.
     * @param targetPath Reserved {@code reviews.json} artifact path.
     * @throws IOException when an existing reserved path cannot be removed or replaced.
     */
    private static void replaceReservedInternalReviewArtifact(
        Path sourcePath,
        Path targetPath
    ) throws IOException {
        if (Files.isDirectory(targetPath, LinkOption.NOFOLLOW_LINKS)) {
            deleteDirectoryTreeNoFollow(targetPath);
        }

        try {
            Files.move(
                sourcePath,
                targetPath,
                StandardCopyOption.REPLACE_EXISTING,
                StandardCopyOption.ATOMIC_MOVE
            );
        } catch (AtomicMoveNotSupportedException error) {
            Files.move(sourcePath, targetPath, StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /**
     * Deletes a real directory tree without following symlinks inside it.
     *
     * @param directoryPath Directory to delete.
     * @throws IOException when walking or deleting the directory fails.
     */
    private static void deleteDirectoryTreeNoFollow(Path directoryPath) throws IOException {
        List<Path> paths = new ArrayList<Path>();
        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            stream.forEach(paths::add);
        }

        paths.sort(Comparator.reverseOrder());
        for (Path path : paths) {
            Files.deleteIfExists(path);
        }
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
     * @param accessTokenProvider Refresh-capable bearer token provider.
     * @param submissionId Submission whose artifacts are uploaded.
     * @param testPhase Scoring phase represented by the artifacts.
     * @param submissionDir Extracted submission directory or workspace root.
     * @throws Exception when zip creation or upload fails.
     */
    private static void uploadArtifacts(
        CloseableHttpClient httpClient,
        String submissionApiUrl,
        AccessTokenProvider accessTokenProvider,
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
        if (!isNonSymlinkDirectory(artifactsDir)) {
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
                    accessTokenProvider,
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
                    accessTokenProvider,
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
            isNonSymlinkRegularFile(executionLog)
                || isNonSymlinkRegularFile(errorLog)
                || directoryHasRegularFiles(publicDir);

        if (!hasPublicArtifacts) {
            logInfo(
                "artifacts.zip.public",
                "No public artifacts found under " + artifactsDir
            );
            return null;
        }

        enforcePublicArtifactOutputLimit(artifactsDir, executionLog, errorLog, publicDir);
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
        if (!isNonSymlinkDirectory(directoryPath)) {
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

        enforceArtifactDirectoryOutputLimit(directoryPath, directoryPath, "private artifacts");
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
        if (!isNonSymlinkDirectory(directoryPath)) {
            return false;
        }

        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            return stream.anyMatch(EcsRunnerMain::isNonSymlinkRegularFile);
        }
    }

    /**
     * Enforces the output byte cap across all files included in the public zip.
     *
     * @param artifactsDir Root artifacts directory.
     * @param executionLog Runner execution log file.
     * @param errorLog Runner error log file.
     * @param publicDir Public artifact directory.
     * @throws IOException When file size inspection fails.
     */
    private static void enforcePublicArtifactOutputLimit(
        Path artifactsDir,
        Path executionLog,
        Path errorLog,
        Path publicDir
    ) throws IOException {
        long totalBytes = 0L;
        totalBytes = addArtifactFileBytesWithLimit(
            totalBytes,
            executionLog,
            artifactsDir,
            "public artifacts"
        );
        totalBytes = addArtifactFileBytesWithLimit(
            totalBytes,
            errorLog,
            artifactsDir,
            "public artifacts"
        );
        totalBytes = enforceArtifactDirectoryOutputLimit(
            publicDir,
            artifactsDir,
            "public artifacts",
            totalBytes
        );
        logInfo(
            "artifacts.output-limit",
            "Public artifacts total sizeBytes="
                + totalBytes
                + ", maxOutputBytes="
                + MAX_OUTPUT_BYTES
        );
    }

    /**
     * Enforces the output byte cap across a whole artifact directory.
     *
     * @param directoryPath Directory whose regular files are counted.
     * @param rootPath Root used to render relative paths in errors.
     * @param outputName Human-readable output label for errors.
     * @throws IOException When walking the directory or reading file sizes fails.
     */
    private static void enforceArtifactDirectoryOutputLimit(
        Path directoryPath,
        Path rootPath,
        String outputName
    ) throws IOException {
        long totalBytes = enforceArtifactDirectoryOutputLimit(
            directoryPath,
            rootPath,
            outputName,
            0L
        );
        logInfo(
            "artifacts.output-limit",
            outputName
                + " total sizeBytes="
                + totalBytes
                + ", maxOutputBytes="
                + MAX_OUTPUT_BYTES
        );
    }

    /**
     * Adds regular file sizes under a directory to a bounded output total.
     *
     * @param directoryPath Directory whose regular files are counted.
     * @param rootPath Root used to render relative paths in errors.
     * @param outputName Human-readable output label for errors.
     * @param currentBytes Bytes already counted.
     * @return Updated byte count.
     * @throws IOException When walking the directory or reading file sizes fails.
     */
    private static long enforceArtifactDirectoryOutputLimit(
        Path directoryPath,
        Path rootPath,
        String outputName,
        long currentBytes
    ) throws IOException {
        if (!Files.isDirectory(directoryPath)) {
            return currentBytes;
        }

        long totalBytes = currentBytes;
        try (java.util.stream.Stream<Path> stream = Files.walk(directoryPath)) {
            java.util.Iterator<Path> iterator = stream.iterator();
            while (iterator.hasNext()) {
                Path entryPath = iterator.next();
                totalBytes = addArtifactFileBytesWithLimit(
                    totalBytes,
                    entryPath,
                    rootPath,
                    outputName
                );
            }
        }
        return totalBytes;
    }

    /**
     * Adds one artifact file's size to a bounded output total.
     *
     * @param currentBytes Bytes already counted.
     * @param filePath File to count when it is a non-symlink regular file.
     * @param rootPath Root used to render relative paths in errors.
     * @param outputName Human-readable output label for errors.
     * @return Updated byte count.
     * @throws IOException When reading file size fails.
     */
    private static long addArtifactFileBytesWithLimit(
        long currentBytes,
        Path filePath,
        Path rootPath,
        String outputName
    ) throws IOException {
        if (filePath == null) {
            return currentBytes;
        }

        if (!isNonSymlinkRegularFile(filePath)) {
            return currentBytes;
        }

        return addOutputBytesWithLimit(
            currentBytes,
            Files.size(filePath),
            outputName + " including " + renderRelativeArtifactPath(rootPath, filePath)
        );
    }

    /**
     * Renders a stable artifact path for output-limit diagnostics.
     *
     * @param rootPath Artifact root.
     * @param filePath Artifact file.
     * @return Relative path when possible, otherwise the absolute path.
     */
    private static String renderRelativeArtifactPath(Path rootPath, Path filePath) {
        if (rootPath == null || filePath == null) {
            return String.valueOf(filePath);
        }

        try {
            return rootPath.relativize(filePath).toString().replace('\\', '/');
        } catch (IllegalArgumentException ignored) {
            return filePath.toString();
        }
    }

    /**
     * Adds a file to zip when it exists and is not a symbolic link.
     *
     * @param zipOutputStream Destination zip stream receiving the entry.
     * @param filePath Candidate file path to archive.
     * @param entryName Zip entry name to use for the file.
     * @throws Exception when a non-symlink regular file cannot be read or archived.
     */
    private static void addFileToZip(
        ZipOutputStream zipOutputStream,
        Path filePath,
        String entryName
    ) throws Exception {
        if (!isNonSymlinkRegularFile(filePath)) {
            logInfo("artifacts.zip.add-file", "Skipping missing or non-regular file: " + filePath);
            return;
        }

        logInfo(
            "artifacts.zip.add-file",
            "Adding file to zip entry " + entryName + " from " + filePath
        );
        try (InputStream inputStream = openRegularFileInputStreamNoFollow(filePath)) {
            zipOutputStream.putNextEntry(new ZipEntry(entryName.replace('\\', '/')));
            try {
                copyStream(inputStream, zipOutputStream);
            } finally {
                zipOutputStream.closeEntry();
            }
        }
    }

    /**
     * Recursively adds non-symlink regular directory contents to a zip stream.
     *
     * @param zipOutputStream Destination zip stream receiving directory entries.
     * @param directoryPath Directory to traverse without following symlinked directories.
     * @param entryPrefix Prefix prepended to each zip entry name.
     * @throws Exception when walking the directory or archiving a regular file fails.
     */
    private static void addDirectoryToZip(
        ZipOutputStream zipOutputStream,
        Path directoryPath,
        String entryPrefix
    ) throws Exception {
        if (!isNonSymlinkDirectory(directoryPath)) {
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
                if (!isNonSymlinkRegularFile(entryPath)) {
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
                try (InputStream inputStream = openRegularFileInputStreamNoFollow(entryPath)) {
                    zipOutputStream.putNextEntry(new ZipEntry(entryName));
                    try {
                        copyStream(inputStream, zipOutputStream);
                    } finally {
                        zipOutputStream.closeEntry();
                    }
                }
            }
        }
    }

    /**
     * Checks whether a path is a regular file without dereferencing symlinks.
     *
     * @param path Path to inspect.
     * @return {@code true} only for non-symlink regular files.
     */
    private static boolean isNonSymlinkRegularFile(Path path) {
        return path != null && Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS);
    }

    /**
     * Checks whether a path is a directory without dereferencing symlinks.
     *
     * @param path Path to inspect.
     * @return {@code true} only for non-symlink directories.
     */
    private static boolean isNonSymlinkDirectory(Path path) {
        return path != null && Files.isDirectory(path, LinkOption.NOFOLLOW_LINKS);
    }

    /**
     * Reads a regular artifact file without following symbolic links.
     *
     * @param filePath Non-symlink regular file path to read.
     * @return Complete file contents.
     * @throws IOException when the file is missing, is not a regular file, is a symlink,
     *                     or cannot be read.
     */
    private static byte[] readRegularFileBytesNoFollow(Path filePath) throws IOException {
        try (
            InputStream inputStream = openRegularFileInputStreamNoFollow(filePath);
            ByteArrayOutputStream outputStream = new ByteArrayOutputStream()
        ) {
            copyStream(inputStream, outputStream);
            return outputStream.toByteArray();
        }
    }

    /**
     * Opens a regular file for reading without following symbolic links.
     *
     * @param filePath Non-symlink regular file path to open.
     * @return Input stream positioned at the start of the file.
     * @throws IOException when the path is missing, not regular, a symlink, or unreadable.
     */
    private static InputStream openRegularFileInputStreamNoFollow(Path filePath)
        throws IOException {
        if (!isNonSymlinkRegularFile(filePath)) {
            throw new IOException("Artifact is not a non-symlink regular file: " + filePath);
        }

        return Files.newInputStream(
            filePath,
            StandardOpenOption.READ,
            LinkOption.NOFOLLOW_LINKS
        );
    }

    /**
     * Copies bytes between streams for Java 8 runtimes.
     *
     * @param inputStream Source stream.
     * @param outputStream Destination stream.
     * @throws IOException when reading or writing fails.
     */
    private static void copyStream(InputStream inputStream, OutputStream outputStream)
        throws IOException {
        byte[] buffer = new byte[STREAM_COPY_BUFFER_SIZE];
        int bytesRead;
        while ((bytesRead = inputStream.read(buffer)) != -1) {
            outputStream.write(buffer, 0, bytesRead);
        }
    }

    /**
     * Uploads zip artifact to submission-api using multipart form data.
     */
    private static void uploadArtifactZip(
        CloseableHttpClient httpClient,
        String submissionApiUrl,
        AccessTokenProvider accessTokenProvider,
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

        for (int attempt = 1; attempt <= 2; attempt++) {
            HttpPost request = new HttpPost(url);
            request.setHeader(
                "Authorization",
                "Bearer " + accessTokenProvider.getToken(httpClient)
            );
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

            boolean retryWithFreshToken = false;
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
                    if (
                        shouldRetryWithRefreshedToken(
                            statusCode,
                            attempt,
                            accessTokenProvider
                        )
                    ) {
                        logWarn(
                            "http.post.artifact",
                            "POST "
                                + url
                                + " returned HTTP 401; refreshing M2M token and retrying once."
                        );
                        retryWithFreshToken = true;
                    } else {
                        throw new RuntimeException(
                            "POST "
                                + url
                                + " failed: HTTP "
                                + statusCode
                                + " - "
                                + responseBody
                        );
                    }
                } else {
                    return;
                }
            }

            if (retryWithFreshToken) {
                refreshAccessTokenAfterUnauthorized(
                    accessTokenProvider,
                    httpClient,
                    "POST " + url
                );
            }
        }

        throw new RuntimeException("POST " + url + " failed after token refresh retry.");
    }

    /**
     * Locates an artifact file across known runner workspace roots.
     */
    private static Path findArtifactFile(Path submissionDir, String relativePath) {
        for (Path baseDir : getArtifactBaseCandidates(submissionDir)) {
            Path candidate = baseDir.resolve("artifacts").resolve(relativePath);
            if (isNonSymlinkRegularFile(candidate)) {
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
            if (isNonSymlinkDirectory(baseDir.resolve("artifacts"))) {
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
     * Writes tester JAR bytes to a unique runner-owned temporary path.
     *
     * @param testerConfigId Tester configuration ID used for diagnostics.
     * @param jarBytes Downloaded tester JAR bytes.
     * @return Path to the restricted tester JAR.
     * @throws IOException When the temporary file cannot be created, written, or restricted.
     */
    private static Path writeTesterJar(String testerConfigId, byte[] jarBytes)
        throws IOException {
        Path jarPath = createRunnerOnlyTempFile("tester-", ".jar");
        Files.write(jarPath, jarBytes);
        secureRunnerOnlyFile(jarPath);
        logInfo(
            "filesystem.testerJar",
            "Wrote tester JAR for testerConfigId="
                + safeLogValue(testerConfigId)
                + " to "
                + jarPath
                + " ("
                + Files.size(jarPath)
                + " bytes)"
        );
        return jarPath;
    }

    /**
     * Creates a temporary file that is never backed by a predictable pre-existing
     * path and is immediately restricted to the trusted runner owner.
     *
     * @param prefix File prefix accepted by {@link Files#createTempFile(String, String, FileAttribute[])}.
     * @param suffix File suffix accepted by {@link Files#createTempFile(String, String, FileAttribute[])}.
     * @return Newly created runner-only temporary file.
     * @throws IOException When the temporary file cannot be created or restricted.
     */
    private static Path createRunnerOnlyTempFile(String prefix, String suffix)
        throws IOException {
        try {
            FileAttribute<Set<PosixFilePermission>> permissions =
                PosixFilePermissions.asFileAttribute(
                    EnumSet.of(
                        PosixFilePermission.OWNER_READ,
                        PosixFilePermission.OWNER_WRITE
                    )
                );
            return Files.createTempFile(prefix, suffix, permissions);
        } catch (UnsupportedOperationException ignored) {
            Path path = Files.createTempFile(prefix, suffix);
            secureRunnerOnlyFile(path);
            return path;
        }
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
        Path submissionSource;
        try {
            submissionSource = locateSubmissionSource(
                submissionRoot,
                expectedSolutionBaseName
            );
        } catch (IllegalArgumentException error) {
            logWarn(
                "submission.validation",
                NO_SUPPORTED_SOURCE_ERROR
                    + " Supported extensions: "
                    + SUPPORTED_SOURCE_EXTENSIONS_TEXT
            );
            return buildNoSupportedSourceResult(testerClassName, artifactsPublicDir);
        }

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
        boolean cleanupDeferred = deferIsolatedChildCleanup(compileWorkDir);
        Path compileLogPath = artifactsPublicDir.resolve("compile_log.txt");

        try {
            CompiledSubmission compiledSubmission = compileAndBuildExecutionCommand(
                submissionSource,
                compileWorkDir,
                compileTimeoutMs,
                expectedSolutionBaseName,
                compileLogPath
            );
            grantScorerReadExecuteAccess(compileWorkDir);

            MarathonController controller = new MarathonController();
            List<Map<String, Object>> testScores = new ArrayList<Map<String, Object>>();
            double totalScore = 0.0;
            int failedTests = 0;
            StringBuilder outputText = new StringBuilder();
            long outputBytes = 0L;

            long endSeed = startSeed + numberOfTests - 1L;
            for (long seed = startSeed; seed <= endSeed; seed++) {
                int testCaseNumber = testScores.size() + 1;
                resetScorerWritableStateForTestCase("before", testCaseNumber);
                MarathonTestResult testResult;
                try {
                    testResult = controller.run(
                        testerClassName,
                        seed,
                        compiledSubmission.getExecutionCommand(),
                        timeLimitMs
                    );
                } finally {
                    resetScorerWritableStateForTestCase("after", testCaseNumber);
                }

                double seedScore = testResult.getScore();
                String seedError = testResult.getError();
                String scoreValidationError = validateScoreValue(
                    seedScore,
                    "Test Case #" + testCaseNumber + " score"
                );
                if (scoreValidationError != null) {
                    logWarn("tester.score", scoreValidationError);
                    seedScore = FAILED_TEST_SCORE;
                    seedError = appendErrorMessage(seedError, scoreValidationError);
                }
                totalScore += seedScore;
                if (seedScore < 0 || (seedError != null && !seedError.trim().isEmpty())) {
                    failedTests += 1;
                }

                Map<String, Object> seedResult = new LinkedHashMap<String, Object>();
                seedResult.put("testcase", Integer.toString(testCaseNumber));
                seedResult.put("score", seedScore);
                seedResult.put("runTimeMs", testResult.getRunTime());
                seedResult.put("error", seedError);
                testScores.add(seedResult);

                StringBuilder testOutputText = new StringBuilder();
                testOutputText.append("Test Case #").append(testCaseNumber).append(":\n");
                testOutputText.append("Score = ").append(seedScore).append('\n');
                testOutputText.append("Run Time = ")
                    .append(testResult.getRunTime())
                    .append("ms\n");
                if (
                    testResult.getError() != null
                        && !testResult.getError().trim().isEmpty()
                ) {
                    testOutputText.append(testResult.getError().trim()).append('\n');
                }
                if (
                    testResult.getStdout() != null
                        && !testResult.getStdout().trim().isEmpty()
                ) {
                    testOutputText.append("stdout:\n")
                        .append(testResult.getStdout().trim())
                        .append('\n');
                }
                if (
                    testResult.getStderr() != null
                        && !testResult.getStderr().trim().isEmpty()
                ) {
                    testOutputText.append("stderr:\n")
                        .append(testResult.getStderr().trim())
                        .append('\n');
                }
                testOutputText.append('\n');
                outputBytes = appendLimitedOutput(
                    outputText,
                    testOutputText.toString(),
                    outputBytes,
                    "artifacts/public/output.txt"
                );

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
            String averageScoreValidationError = validateScoreValue(
                averageScore,
                "Aggregate score"
            );
            if (averageScoreValidationError != null) {
                logWarn("tester.score", averageScoreValidationError);
                averageScore = FAILED_TEST_SCORE;
            }

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
            if (!cleanupDeferred) {
                deletePathRecursively(compileWorkDir);
            }
        }
    }

    /**
     * Defers an isolated child temporary path until the child has emitted its
     * final success or failure output.
     *
     * <p>Compiler start failures include the working directory in the JVM error
     * message. Cleaning that directory from the generic runner's inner
     * {@code finally} block before the child reports the failure makes logs look
     * like cleanup raced ahead of compilation. Deferring child-scoped paths keeps
     * cleanup after compilation/execution and after the child has reported its
     * result.
     *
     * @param path Temporary file or directory to delete at child process exit.
     * @return {@code true} when cleanup was registered with the child scope;
     *         {@code false} when no child cleanup scope is active.
     */
    private static boolean deferIsolatedChildCleanup(Path path) {
        if (path == null) {
            return false;
        }

        List<Path> cleanupPaths = DEFERRED_ISOLATED_CLEANUP_PATHS.get();
        if (cleanupPaths == null) {
            return false;
        }

        cleanupPaths.add(path);
        return true;
    }

    /**
     * Deletes temporary paths registered for the isolated child process.
     *
     * @param cleanupPaths Child-scoped paths collected during tester execution.
     */
    private static void cleanupDeferredIsolatedChildPaths(List<Path> cleanupPaths) {
        if (cleanupPaths == null || cleanupPaths.isEmpty()) {
            return;
        }

        for (int index = cleanupPaths.size() - 1; index >= 0; index--) {
            deletePathRecursively(cleanupPaths.get(index));
        }
    }

    /**
     * Writes a member-visible validation error for submissions that do not contain
     * a supported source file and returns a structured failed result.
     *
     * @param testerClassName Fully qualified Marathon tester class name.
     * @param artifactsPublicDir Public artifact directory where {@code output.txt} is written.
     * @return Failed tester execution result with validation metadata.
     * @throws IOException When the public output artifact cannot be written.
     */
    private static TesterExecutionResult buildNoSupportedSourceResult(
        String testerClassName,
        Path artifactsPublicDir
    ) throws IOException {
        String outputText =
            "Submission error: "
                + NO_SUPPORTED_SOURCE_ERROR
                + "\nSupported extensions: "
                + SUPPORTED_SOURCE_EXTENSIONS_TEXT
                + "\n";
        Files.write(
            artifactsPublicDir.resolve("output.txt"),
            outputText.getBytes(StandardCharsets.UTF_8)
        );

        Map<String, Object> metadata = new LinkedHashMap<String, Object>();
        metadata.put("testerClass", testerClassName);
        metadata.put("submissionError", NO_SUPPORTED_SOURCE_ERROR);
        metadata.put(
            "supportedExtensions",
            new ArrayList<String>(SUPPORTED_SOURCE_EXTENSIONS)
        );
        metadata.put("numberOfTests", 0);

        Map<String, Object> currentReview = new LinkedHashMap<String, Object>();
        currentReview.put("score", -1.0);
        currentReview.put("aggregateScore", -1.0);
        currentReview.put("metadata", metadata);

        return new TesterExecutionResult(
            -1.0,
            metadata,
            currentReview,
            new ArrayList<Map<String, Object>>()
        );
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
                NO_SUPPORTED_SOURCE_ERROR
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
     * @return {@code true} for C++, Java, Python, Mono C#, .NET 7/10 C#, or Rust submissions.
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
                Arrays.asList(
                    "javac",
                    "--release",
                    JAVA_SUBMISSION_RELEASE,
                    workDir.relativize(normalizedSource).toString()
                ),
                workDir,
                compileTimeoutMs,
                "Java compilation failed.",
                compileLogPath
            );
            runJavaStartupCheck(workDir, entryPoint, compileTimeoutMs, compileLogPath);
            return new CompiledSubmission(
                buildScorerExecutionCommand(
                    "java -Xms1G -Xmx1G -cp "
                        + workDir.toAbsolutePath()
                        + " "
                        + entryPoint.getQualifiedClassName()
                ),
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
                    CXX_MARCH_FLAG,
                    CXX_MTUNE_FLAG,
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
                buildScorerExecutionCommand(binaryPath),
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".py".equals(extension)) {
            return new CompiledSubmission(
                buildScorerExecutionCommand("python3 " + normalizedSource.toAbsolutePath()),
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
                buildScorerExecutionCommand(binaryPath),
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
                buildScorerExecutionCommand("mono " + exePath),
                normalizedSource.getFileName().toString(),
                language
            );
        }

        if (".cs_net10".equals(extension) || ".cs_net7".equals(extension)) {
            String targetFramework = dotNetTargetFramework(extension);
            Path csproj = workDir.resolve(GENERIC_SOLUTION_BASE_NAME + ".csproj");
            Files.write(
                csproj,
                Arrays.asList(
                    "<Project Sdk=\"Microsoft.NET.Sdk\">",
                    "  <PropertyGroup>",
                    "    <TargetFramework>" + targetFramework + "</TargetFramework>",
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
                "C# (" + targetFramework + ") compilation failed.",
                compileLogPath
            );
            return new CompiledSubmission(
                buildScorerExecutionCommand(
                    "dotnet "
                        + publishDir
                            .resolve(GENERIC_SOLUTION_BASE_NAME + ".dll")
                            .toAbsolutePath()
                ),
                normalizedCsSource.getFileName().toString(),
                language
            );
        }

        throw new IllegalArgumentException("Unsupported submission extension: " + extension);
    }

    /**
     * Maps a .NET C# submission extension to the project target framework.
     *
     * @param extension Supported .NET C# source extension.
     * @return Target framework moniker used in the generated project file.
     * @throws IllegalArgumentException When the extension is not a .NET C# submission extension.
     */
    private static String dotNetTargetFramework(String extension) {
        if (".cs_net7".equals(extension)) {
            return "net7.0";
        }
        if (".cs_net10".equals(extension)) {
            return "net10.0";
        }
        throw new IllegalArgumentException("Unsupported .NET C# extension: " + extension);
    }

    /**
     * Loads the compiled Java submission class in an isolated JVM so static initializers
     * are covered by the configured compile timeout before seed execution starts.
     *
     * @param workDir Temporary compile workspace containing the compiled submission.
     * @param entryPoint Resolved Java submission entry point.
     * @param compileTimeoutMs Compile/startup timeout in milliseconds.
     * @param compileLogPath Public artifact file that receives check output.
     * @throws Exception When the helper cannot be written/compiled, the class fails to load,
     *                   or the startup check times out.
     */
    private static void runJavaStartupCheck(
        Path workDir,
        JavaEntryPoint entryPoint,
        int compileTimeoutMs,
        Path compileLogPath
    ) throws Exception {
        Path checkRoot = workDir.resolve(".topcoder-java-startup-check");
        Path sourcePath = checkRoot.resolve(
            Paths.get(
                "src",
                "com",
                "topcoder",
                "runner",
                "startupcheck",
                "JavaStartupCheck.java"
            )
        );
        Path classesDir = checkRoot.resolve("classes");
        Path checkWorkDir = checkRoot.resolve("work");

        try {
            Files.createDirectories(sourcePath.getParent());
            Files.createDirectories(classesDir);
            Files.createDirectories(checkWorkDir);
            Files.write(sourcePath, JAVA_STARTUP_CHECK_SOURCE.getBytes(StandardCharsets.UTF_8));

            runCommand(
                Arrays.asList(
                    "javac",
                    "-d",
                    classesDir.toAbsolutePath().toString(),
                    sourcePath.toAbsolutePath().toString()
                ),
                workDir,
                compileTimeoutMs,
                "Java startup check helper compilation failed.",
                compileLogPath
            );

            grantScorerReadExecuteAccess(workDir);
            runCommand(
                Arrays.asList(
                    SCORER_ISOLATION_WRAPPER_PATH,
                    "java",
                    "-Xms1G",
                    "-Xmx1G",
                    "-cp",
                    classesDir.toAbsolutePath().toString()
                        + System.getProperty("path.separator")
                        + workDir.toAbsolutePath().toString(),
                    JAVA_STARTUP_CHECK_CLASS_NAME,
                    entryPoint.getQualifiedClassName()
                ),
                checkWorkDir,
                compileTimeoutMs,
                "Java startup check failed.",
                compileLogPath
            );
        } finally {
            deletePathRecursively(checkRoot);
        }
    }

    /**
     * Prefixes a compiled/interpreted submission command with the scorer
     * isolation helper.
     *
     * <p>{@link MarathonTester} ultimately launches this string with
     * {@code Runtime.exec(String)}, so arguments are kept whitespace-delimited and
     * generated paths are controlled by the runner.
     *
     * @param command Submission command built by the generic runner.
     * @return Command that executes the submission as the low-privilege scorer user.
     */
    private static String buildScorerExecutionCommand(String command) {
        return SCORER_ISOLATION_WRAPPER_PATH + " " + command;
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
        if (".cs_net10".equals(extension)) {
            return "csharp-net10";
        }
        if (".cs_net7".equals(extension)) {
            return "csharp-net7";
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
     * Validates a score before it is included in runner output or callback JSON.
     *
     * <p>Negative values are preserved because Marathon Match uses negative scores as failed
     * test sentinels. Non-finite values and values larger than Java {@code Long.MAX_VALUE}
     * cannot be safely persisted by review summations.
     *
     * @param score Score value to validate.
     * @param label Human-readable score context for diagnostics.
     * @return Error message when invalid, otherwise {@code null}.
     */
    private static String validateScoreValue(double score, String label) {
        if (Double.isNaN(score) || Double.isInfinite(score)) {
            return label
                + " is invalid: "
                + score
                + ". Scores must be finite and no greater than "
                + MAX_SCORE_VALUE_LABEL
                + ".";
        }

        if (score > MAX_SCORE_VALUE) {
            return label
                + " is invalid: "
                + score
                + ". Scores must be no greater than "
                + MAX_SCORE_VALUE_LABEL
                + ".";
        }

        return null;
    }

    /**
     * Appends a validation error to an existing testcase error string.
     *
     * @param existing Existing tester error text, possibly blank.
     * @param addition Validation error to append.
     * @return Combined error text.
     */
    private static String appendErrorMessage(String existing, String addition) {
        if (existing == null || existing.trim().isEmpty()) {
            return addition;
        }
        return existing.trim() + "\n" + addition;
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
            double score = ((Number) runResult).doubleValue();
            requireValidScoreValue(score, "runTester Number score");
            return new TesterExecutionResult(
                score,
                new LinkedHashMap<String, Object>()
            );
        }

        if (runResult instanceof ScoringResult) {
            logInfo("tester.result", "runTester returned ScoringResult object.");
            double score = ((ScoringResult) runResult).getScore();
            requireValidScoreValue(score, "runTester ScoringResult score");
            return new TesterExecutionResult(
                score,
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
            requireValidScoreValue(mapScore.doubleValue(), "runTester map score");

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
     * Throws when a score cannot be safely serialized and persisted.
     *
     * @param score Score to validate.
     * @param label Human-readable score context for diagnostics.
     * @throws RuntimeException When the score is non-finite or larger than {@code Long.MAX_VALUE}.
     */
    private static void requireValidScoreValue(double score, String label) {
        String validationError = validateScoreValue(score, label);
        if (validationError != null) {
            throw new RuntimeException(validationError);
        }
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
     * Provides the trusted parent runner with an M2M bearer token that can be
     * refreshed across long-running system tests.
     */
    private static class AccessTokenProvider {
        private String accessToken;
        private final String auth0Url;
        private final String auth0Audience;
        private final String auth0ProxyServerUrl;
        private final String auth0ClientId;
        private final String auth0ClientSecret;
        private long expiresAtEpochSeconds;

        AccessTokenProvider(
            String initialAccessToken,
            String auth0Url,
            String auth0Audience,
            String auth0ProxyServerUrl,
            String auth0ClientId,
            String auth0ClientSecret
        ) {
            this.accessToken = initialAccessToken;
            this.auth0Url = auth0Url;
            this.auth0Audience = auth0Audience;
            this.auth0ProxyServerUrl = auth0ProxyServerUrl;
            this.auth0ClientId = auth0ClientId;
            this.auth0ClientSecret = auth0ClientSecret;
            this.expiresAtEpochSeconds = extractJwtExpirationEpochSeconds(initialAccessToken);
        }

        synchronized String getToken(CloseableHttpClient httpClient) throws Exception {
            if (isBlank(accessToken)) {
                return refreshToken(httpClient, "no cached access token");
            }

            if (isTokenExpiringSoon() && canRefresh()) {
                return refreshToken(httpClient, "cached access token expires soon");
            }

            return accessToken;
        }

        synchronized boolean canRefresh() {
            return !isBlank(resolveTokenUrl())
                && !isBlank(auth0ClientId)
                && !isBlank(auth0ClientSecret);
        }

        synchronized String refreshToken(CloseableHttpClient httpClient, String reason)
            throws Exception {
            if (!canRefresh()) {
                throw new IllegalStateException(
                    "M2M token refresh is not configured for the ECS runner. "
                        + "AUTH0_CLIENT_ID, AUTH0_CLIENT_SECRET, and AUTH0_URL or "
                        + "AUTH0_PROXY_SERVER_URL are required."
                );
            }

            String tokenUrl = resolveTokenUrl();
            Map<String, Object> payload = new LinkedHashMap<String, Object>();
            payload.put("grant_type", "client_credentials");
            payload.put("client_id", auth0ClientId);
            payload.put("client_secret", auth0ClientSecret);
            if (!isBlank(auth0Url)) {
                payload.put("auth0_url", auth0Url);
            }
            if (!isBlank(auth0Audience)) {
                payload.put("audience", auth0Audience);
            }

            String payloadJson = OBJECT_MAPPER.writeValueAsString(payload);
            HttpPost request = new HttpPost(tokenUrl);
            request.setHeader("Content-Type", "application/json");
            request.setEntity(new StringEntity(payloadJson, StandardCharsets.UTF_8));

            logInfo(
                "auth.token.refresh",
                "Refreshing M2M access token, reason="
                    + safeLogValue(reason)
                    + ", tokenUrl="
                    + tokenUrl
            );

            try (CloseableHttpResponse response = httpClient.execute(request)) {
                int statusCode = response.getStatusLine().getStatusCode();
                String responseBody = response.getEntity() == null
                    ? ""
                    : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);

                if (statusCode < 200 || statusCode >= 300) {
                    throw new RuntimeException(
                        "Failed to refresh M2M token: HTTP "
                            + statusCode
                            + " - "
                            + truncate(responseBody, HTTP_BODY_PREVIEW_LIMIT)
                    );
                }

                M2MTokenResponse tokenResponse = OBJECT_MAPPER.readValue(
                    responseBody,
                    M2MTokenResponse.class
                );
                if (!isBlank(tokenResponse.getAccessToken())) {
                    accessToken = tokenResponse.getAccessToken();
                    expiresAtEpochSeconds = resolveExpiryEpochSeconds(
                        accessToken,
                        tokenResponse.getExpiresIn()
                    );
                    logInfo(
                        "auth.token.refresh",
                        "Refreshed M2M access token; expiresAtEpochSeconds="
                            + (expiresAtEpochSeconds <= 0
                                ? "<unknown>"
                                : String.valueOf(expiresAtEpochSeconds))
                    );
                    return accessToken;
                }

                if (!isBlank(tokenResponse.getError())) {
                    throw new RuntimeException(
                        "Failed to refresh M2M token: "
                            + tokenResponse.getError()
                            + " "
                            + safeLogValue(tokenResponse.getErrorDescription())
                    );
                }

                throw new RuntimeException(
                    "M2M token response did not include access_token."
                );
            }
        }

        private boolean isTokenExpiringSoon() {
            return expiresAtEpochSeconds > 0
                && Instant.now().getEpochSecond()
                    >= expiresAtEpochSeconds - TOKEN_REFRESH_SKEW_SECONDS;
        }

        private String resolveTokenUrl() {
            if (!isBlank(auth0ProxyServerUrl)) {
                return auth0ProxyServerUrl;
            }
            return auth0Url;
        }

        private long resolveExpiryEpochSeconds(String token, Long expiresInSeconds) {
            long tokenExpiry = extractJwtExpirationEpochSeconds(token);
            if (tokenExpiry > 0) {
                return tokenExpiry;
            }
            if (expiresInSeconds != null && expiresInSeconds.longValue() > 0L) {
                return Instant.now().getEpochSecond() + expiresInSeconds.longValue();
            }
            return 0L;
        }

        @SuppressWarnings("unchecked")
        private long extractJwtExpirationEpochSeconds(String token) {
            try {
                String payloadJson = decodeJwtSection(token, 1);
                if (payloadJson == null) {
                    return 0L;
                }
                Map<String, Object> payload = OBJECT_MAPPER.readValue(
                    payloadJson,
                    Map.class
                );
                return parseEpochSeconds(payload.get("exp"));
            } catch (Exception ignored) {
                return 0L;
            }
        }

        private long parseEpochSeconds(Object value) {
            if (value instanceof Number) {
                return ((Number) value).longValue();
            }
            if (value instanceof String) {
                try {
                    return Long.parseLong(((String) value).trim());
                } catch (NumberFormatException ignored) {
                    return 0L;
                }
            }
            return 0L;
        }
    }

    /**
     * Partial Auth0/proxy M2M token response.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private static class M2MTokenResponse {
        @JsonProperty("access_token")
        private String accessToken;

        @JsonProperty("expires_in")
        private Long expiresIn;

        @JsonProperty("error")
        private String error;

        @JsonProperty("error_description")
        private String errorDescription;

        String getAccessToken() {
            return accessToken;
        }

        Long getExpiresIn() {
            return expiresIn;
        }

        String getError() {
            return error;
        }

        String getErrorDescription() {
            return errorDescription;
        }
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
            requireValidScoreValue(score, "TesterExecutionResult score");
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
