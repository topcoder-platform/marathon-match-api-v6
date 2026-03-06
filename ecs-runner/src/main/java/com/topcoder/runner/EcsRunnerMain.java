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
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
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

    /**
     * Executes the ECS runner workflow end-to-end using environment-provided IDs and token.
     * @param args Unused CLI arguments. Runtime configuration is provided through env vars.
     */
    public static void main(String[] args) {
        int exitCode = 2;
        Path submissionDir = null;
        Path testerJarPath = null;

        try {
            String challengeId = getRequiredEnv("TESTER_CONFIG_ID");
            String submissionId = getRequiredEnv("SUBMISSION_ID");
            String accessToken = getRequiredEnv("ACCESS_TOKEN");
            boolean debugLogAccessToken = isTruthyEnv("DEBUG_LOG_ACCESS_TOKEN");
            boolean debugLogFullAccessToken = isTruthyEnv("DEBUG_LOG_FULL_ACCESS_TOKEN");
            String marathonMatchBaseUrl = buildMarathonMatchBaseUrl(
                getRequiredEnv("MARATHON_MATCH_API_URL")
            );
            String reviewTypeId = getRequiredEnv("REVIEW_TYPE_ID");
            String testPhase = normalizeTestPhase(getOptionalEnv("TEST_PHASE", "provisional"));
            int phaseStartSeed = getOptionalIntEnv("PHASE_START_SEED", 0);
            int phaseNumberOfTests = getOptionalIntEnv("PHASE_NUMBER_OF_TESTS", 0);

            if (debugLogAccessToken) {
                logAccessTokenDebug(accessToken, debugLogFullAccessToken);
            }

            try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
                MarathonMatchConfigResponse config = fetchJson(
                    httpClient,
                    marathonMatchBaseUrl + "/challenge/" + challengeId,
                    accessToken,
                    MarathonMatchConfigResponse.class
                );

                byte[] testerJarBytes = fetchBinary(
                    httpClient,
                    marathonMatchBaseUrl + "/challenge/" + challengeId + "/tester-jar",
                    accessToken
                );

                testerJarPath = writeTesterJar(challengeId, testerJarBytes);

                TesterResponse tester = fetchJson(
                    httpClient,
                    marathonMatchBaseUrl + "/testers/" + config.getTesterId(),
                    accessToken,
                    TesterResponse.class
                );

                submissionDir = Paths.get("/tmp/submission-" + submissionId);
                SubmissionService submissionService = new SubmissionService(
                    config.getSubmissionApiUrl(),
                    accessToken
                );
                submissionService.downloadSubmission(submissionId, submissionDir.toString());

                ScorerConfig scorerConfig = buildScorerConfig(
                    config,
                    tester,
                    reviewTypeId,
                    phaseStartSeed,
                    phaseNumberOfTests
                );

                TesterExecutionResult testerExecution = runTester(
                    tester.getClassName(),
                    submissionDir.toString(),
                    scorerConfig,
                    testerJarPath
                );

                uploadArtifacts(
                    httpClient,
                    config.getSubmissionApiUrl(),
                    accessToken,
                    submissionId,
                    testPhase,
                    submissionDir
                );

                ScoringCallbackRequest callbackRequest = new ScoringCallbackRequest(
                    submissionId,
                    testerExecution.getScore(),
                    testPhase,
                    reviewTypeId,
                    scorerConfig.getScoreCardId(),
                    buildCallbackMetadata(testerExecution.getMetadata(), testPhase, reviewTypeId),
                    readOptionalJsonMap(findArtifactFile(submissionDir, "private/current.json")),
                    readOptionalJsonList(findArtifactFile(submissionDir, "private/reviews.json"))
                );

                postScoringCallback(
                    httpClient,
                    marathonMatchBaseUrl,
                    accessToken,
                    callbackRequest
                );

                ScoringResult result = new ScoringResult(testerExecution.getScore(), "completed");
                System.out.println(OBJECT_MAPPER.writeValueAsString(result));
                exitCode = 0;
            }
        } catch (Exception error) {
            error.printStackTrace();
        } finally {
            deletePathRecursively(submissionDir);
            deletePathRecursively(testerJarPath);
            System.exit(exitCode);
        }
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
        String normalized = value.trim().toLowerCase();
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
        System.out.println("[DEBUG] ACCESS_TOKEN length: " + accessToken.length());
        System.out.println(
            "[DEBUG] ACCESS_TOKEN value: "
                + (logFullToken ? accessToken : redactToken(accessToken))
        );

        String headerJson = decodeJwtSection(accessToken, 0);
        if (headerJson != null) {
            System.out.println("[DEBUG] ACCESS_TOKEN header: " + headerJson);
        } else {
            System.out.println("[DEBUG] ACCESS_TOKEN header: <unavailable>");
        }

        String payloadJson = decodeJwtSection(accessToken, 1);
        if (payloadJson != null) {
            System.out.println("[DEBUG] ACCESS_TOKEN payload: " + payloadJson);
        } else {
            System.out.println("[DEBUG] ACCESS_TOKEN payload: <unavailable>");
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
        String normalized = (testPhase == null ? "" : testPhase.trim().toLowerCase());
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
        String body = executeGetAsString(httpClient, url, accessToken);
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

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            if (statusCode < 200 || statusCode >= 300) {
                String responseBody = response.getEntity() == null
                    ? ""
                    : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);
                throw new RuntimeException(
                    "GET " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }

            if (response.getEntity() == null) {
                throw new RuntimeException("GET " + url + " returned empty response body.");
            }

            try (InputStream inputStream = response.getEntity().getContent()) {
                return readAllBytes(inputStream);
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

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);

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

        try (CloseableHttpResponse response = httpClient.execute(request)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = response.getEntity() == null
                ? ""
                : EntityUtils.toString(response.getEntity(), StandardCharsets.UTF_8);

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
            return;
        }

        Path artifactsDir = artifactBaseDir.resolve("artifacts");
        if (!Files.isDirectory(artifactsDir)) {
            return;
        }

        String baseArtifactName = submissionId + "-" + testPhase;
        String internalArtifactName = baseArtifactName + "-internal";

        Path publicZip = null;
        Path privateZip = null;

        try {
            publicZip = createPublicArtifactZip(artifactsDir, submissionId, baseArtifactName);
            if (publicZip != null) {
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

        return zipPath;
    }

    /**
     * Creates a zip archive from a directory. Returns null when directory is missing.
     */
    private static Path createDirectoryZip(Path directoryPath, String artifactName)
        throws Exception {
        if (!Files.isDirectory(directoryPath)) {
            return null;
        }

        Path zipPath = Files.createTempFile(artifactName + "-", ".zip");
        try (ZipOutputStream zipOutputStream = new ZipOutputStream(
            Files.newOutputStream(zipPath)
        )) {
            addDirectoryToZip(zipOutputStream, directoryPath, "");
        }

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
            return;
        }

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
            return null;
        }

        return (Map<String, Object>) OBJECT_MAPPER.readValue(path.toFile(), Map.class);
    }

    /**
     * Reads JSON list when file exists.
     */
    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> readOptionalJsonList(Path path)
        throws Exception {
        if (path == null || !Files.isRegularFile(path)) {
            return null;
        }

        List<Object> rawList = OBJECT_MAPPER.readValue(path.toFile(), List.class);
        List<Map<String, Object>> result = new ArrayList<Map<String, Object>>();

        for (Object entry : rawList) {
            if (entry instanceof Map) {
                result.add((Map<String, Object>) entry);
            }
        }

        return result;
    }

    /**
     * Writes tester JAR bytes to deterministic tmp path.
     */
    private static Path writeTesterJar(String testerConfigId, byte[] jarBytes)
        throws IOException {
        Path jarPath = Paths.get("/tmp/tester-" + testerConfigId + ".jar");
        Files.write(jarPath, jarBytes);
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
        try (URLClassLoader loader = new URLClassLoader(
            urls,
            EcsRunnerMain.class.getClassLoader()
        )) {
            Class<?> testerClass = Class.forName(testerClassName, true, loader);
            Method runTesterMethod = testerClass.getMethod(
                "runTester",
                String.class,
                ScorerConfig.class
            );
            Object runResult = runTesterMethod.invoke(null, submissionDir, scorerConfig);
            return parseTesterExecutionResult(runResult, testerClassName);
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
            return new TesterExecutionResult(
                ((Number) runResult).doubleValue(),
                new LinkedHashMap<String, Object>()
            );
        }

        if (runResult instanceof ScoringResult) {
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
                            System.err.println(
                                "Failed to delete "
                                    + entry
                                    + ": "
                                    + cleanupError.getMessage()
                            );
                        }
                    });
                return;
            }

            Files.deleteIfExists(path);
        } catch (Exception error) {
            System.err.println(
                "Cleanup failed for " + path + ": " + error.getMessage()
            );
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
            String submissionId,
            double score,
            String testPhase,
            String reviewTypeId,
            String scorecardId,
            Map<String, Object> metadata,
            Map<String, Object> currentReview,
            List<Map<String, Object>> impactedReviews
        ) {
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
