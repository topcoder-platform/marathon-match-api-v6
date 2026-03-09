package com.topcoder.runner;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.topcoder.scorer.models.ScorerConfig;
import com.topcoder.scorer.models.ScoringResult;
import com.topcoder.scorer.services.SubmissionService;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.lang.reflect.Method;
import java.net.URL;
import java.net.URLClassLoader;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
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

    private static String logChallengeId = "<unset>";
    private static String logSubmissionId = "<unset>";
    private static String logTestPhase = "<unset>";

    /**
     * Executes the ECS runner workflow end-to-end using environment-provided IDs and token.
     * @param args Unused CLI arguments. Runtime configuration is provided through env vars.
     */
    public static void main(String[] args) {
        int exitCode = 2;
        Path submissionDir = null;
        Path testerJarPath = null;
        String challengeId = "<missing>";
        String submissionId = "<missing>";
        String testPhase = "provisional";

        try {
            challengeId = getRequiredEnv("TESTER_CONFIG_ID");
            submissionId = getRequiredEnv("SUBMISSION_ID");
            String accessToken = getRequiredEnv("ACCESS_TOKEN");
            boolean debugLogAccessToken = isTruthyEnv("DEBUG_LOG_ACCESS_TOKEN");
            boolean debugLogFullAccessToken = isTruthyEnv("DEBUG_LOG_FULL_ACCESS_TOKEN");
            String marathonMatchBaseUrl = buildMarathonMatchBaseUrl(
                getRequiredEnv("MARATHON_MATCH_API_URL")
            );
            String reviewTypeId = getRequiredEnv("REVIEW_TYPE_ID");
            testPhase = normalizeTestPhase(getOptionalEnv("TEST_PHASE", "provisional"));
            int phaseStartSeed = getOptionalIntEnv("PHASE_START_SEED", 0);
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

                logInfo(
                    "tester.invoke",
                    "Invoking tester class "
                        + tester.getClassName()
                        + " with submissionDir="
                        + submissionDir
                );
                TesterExecutionResult testerExecution = runTester(
                    tester.getClassName(),
                    submissionDir.toString(),
                    scorerConfig,
                    testerJarPath
                );
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

                Map<String, Object> currentReview = readOptionalJsonMap(
                    findArtifactFile(submissionDir, "private/current.json")
                );
                List<Map<String, Object>> impactedReviews = readOptionalJsonList(
                    findArtifactFile(submissionDir, "private/reviews.json")
                );
                logCurrentAndImpactedReviews(currentReview, impactedReviews);

                Map<String, Object> callbackMetadata = buildCallbackMetadata(
                    testerExecution.getMetadata(),
                    testPhase,
                    reviewTypeId
                );
                logMap("callback.metadata", callbackMetadata);

                ScoringCallbackRequest callbackRequest = new ScoringCallbackRequest(
                    challengeId,
                    submissionId,
                    testerExecution.getScore(),
                    testPhase,
                    reviewTypeId,
                    scorerConfig.getScoreCardId(),
                    callbackMetadata,
                    currentReview,
                    impactedReviews
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
     * @param scorerConfig Scorer config passed to tester runTester().
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
                + ", startSeed="
                + scorerConfig.getStartSeed()
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
     * Logs callback review payload context loaded from private artifacts.
     * @param currentReview Current review map parsed from current.json.
     * @param impactedReviews Impacted reviews parsed from reviews.json.
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
     * Builds callback metadata with enforced testType and reviewTypeId.
     */
    private static Map<String, Object> buildCallbackMetadata(
        Map<String, Object> metadata,
        String testPhase,
        String reviewTypeId
    ) {
        Map<String, Object> result = metadata == null
            ? new LinkedHashMap<String, Object>()
            : new LinkedHashMap<String, Object>(metadata);

        result.put("testType", normalizeTestPhase(testPhase));
        result.put("reviewTypeId", reviewTypeId);
        return result;
    }

    /**
     * Uploads public and private submission artifacts when present.
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
                || Files.isDirectory(publicDir);

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
     * Creates a zip archive from a directory. Returns null when directory is missing.
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
     * Reads JSON map when file exists.
     */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> readOptionalJsonMap(Path path) throws Exception {
        if (path == null || !Files.isRegularFile(path)) {
            logInfo("artifacts.read-json-map", "No JSON map file found.");
            return null;
        }

        Map<String, Object> parsed = (Map<String, Object>) OBJECT_MAPPER.readValue(
            path.toFile(),
            Map.class
        );
        logInfo(
            "artifacts.read-json-map",
            "Loaded JSON map from " + path + " with keys=" + parsed.keySet()
        );
        return parsed;
    }

    /**
     * Reads JSON list when file exists.
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> readOptionalJsonList(Path path)
        throws Exception {
        if (path == null || !Files.isRegularFile(path)) {
            logInfo("artifacts.read-json-list", "No JSON list file found.");
            return null;
        }

        List<Object> rawList = OBJECT_MAPPER.readValue(path.toFile(), List.class);
        List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();

        for (Object entry : rawList) {
            if (entry instanceof Map) {
                result.add((Map<String, Object>) entry);
            }
        }

        logInfo(
            "artifacts.read-json-list",
            "Loaded JSON list from " + path + " with entries=" + result.size()
        );
        return result;
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
     * Builds scorer config consumed by tester runTester(String, ScorerConfig).
     */
    private static ScorerConfig buildScorerConfig(
        MarathonMatchConfigResponse config,
        TesterResponse tester,
        String reviewTypeId,
        int phaseStartSeed,
        int phaseNumberOfTests
    ) {
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
     * Loads tester class from downloaded JAR and invokes runTester(String, ScorerConfig).
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
                        + ". Looking up runTester method."
                );
                Method runTesterMethod = testerClass.getMethod(
                    "runTester",
                    String.class,
                    ScorerConfig.class
                );
                logInfo(
                    "tester.invoke",
                    "Invoking runTester(String, ScorerConfig) on class "
                        + testerClassName
                );
                Object runResult = runTesterMethod.invoke(null, submissionDir, scorerConfig);
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
                "runTester returned map score=" + mapScore + ", metadataKeys="
                    + asMap(resultMap.get("metadata")).keySet()
            );
            return new TesterExecutionResult(
                mapScore.doubleValue(),
                asMap(resultMap.get("metadata"))
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
            this.scorecardId = scorecardId;
            this.metadata = metadata;
            this.currentReview = currentReview;
            this.impactedReviews = impactedReviews;
        }
    }

    /**
     * Captures tester execution output consumed by callback/reporting logic.
     */
    private static class TesterExecutionResult {
        private final double score;
        private final Map<String, Object> metadata;

        TesterExecutionResult(double score, Map<String, Object> metadata) {
            this.score = score;
            this.metadata = metadata == null
                ? new LinkedHashMap<String, Object>()
                : metadata;
        }

        double getScore() {
            return score;
        }

        Map<String, Object> getMetadata() {
            return metadata;
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
