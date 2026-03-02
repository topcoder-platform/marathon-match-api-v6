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
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPost;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.util.EntityUtils;

/**
 * ECS entrypoint that fetches marathon match config and tester artifacts from API,
 * runs the tester against a submission, and posts the resulting review summation.
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
            String testerConfigId = getRequiredEnv("TESTER_CONFIG_ID");
            String submissionId = getRequiredEnv("SUBMISSION_ID");
            String accessToken = getRequiredEnv("ACCESS_TOKEN");
            String marathonMatchApiUrl = normalizeBaseUrl(
                getRequiredEnv("MARATHON_MATCH_API_URL")
            );
            String reviewApiUrl = normalizeBaseUrl(getRequiredEnv("REVIEW_API_URL"));
            String reviewTypeId = getRequiredEnv("REVIEW_TYPE_ID");

            try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
                MarathonMatchConfigResponse config = fetchJson(
                    httpClient,
                    marathonMatchApiUrl
                        + "/v6/marathon-match/challenge/"
                        + testerConfigId,
                    accessToken,
                    MarathonMatchConfigResponse.class
                );

                byte[] testerJarBytes = fetchBinary(
                    httpClient,
                    marathonMatchApiUrl
                        + "/v6/marathon-match/challenge/"
                        + testerConfigId
                        + "/tester-jar",
                    accessToken
                );

                testerJarPath = writeTesterJar(testerConfigId, testerJarBytes);

                TesterResponse tester = fetchJson(
                    httpClient,
                    marathonMatchApiUrl
                        + "/v6/marathon-match/testers/"
                        + config.getTesterId(),
                    accessToken,
                    TesterResponse.class
                );

                submissionDir = Paths.get("/tmp/submission-" + submissionId);
                SubmissionService submissionService = new SubmissionService(
                    config.getSubmissionApiUrl(),
                    accessToken
                );
                submissionService.downloadSubmission(
                    submissionId,
                    submissionDir.toString()
                );

                ScorerConfig scorerConfig = buildScorerConfig(
                    config,
                    tester,
                    reviewTypeId
                );

                double score = runTester(
                    tester.getClassName(),
                    submissionDir.toString(),
                    scorerConfig,
                    testerJarPath
                );

                Map<String, Object> metadata = new HashMap<String, Object>();
                metadata.put("testType", "provisional");
                metadata.put("reviewTypeId", reviewTypeId);

                ReviewSummationRequest reviewSummation = new ReviewSummationRequest(
                    submissionId,
                    score,
                    scorerConfig.getScoreCardId(),
                    true,
                    Boolean.FALSE,
                    Boolean.TRUE,
                    Boolean.FALSE,
                    metadata
                );
                postReviewSummation(
                    httpClient,
                    reviewApiUrl,
                    accessToken,
                    reviewSummation
                );

                ScoringResult result = new ScoringResult(score, "completed");
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
     * @param variableName Environment variable name.
     * @return Trimmed environment variable value.
     * @throws IllegalArgumentException When the variable is missing or blank.
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
     * Removes trailing slashes from an API base URL.
     * @param baseUrl Candidate base URL.
     * @return URL without trailing slash suffixes.
     */
    private static String normalizeBaseUrl(String baseUrl) {
        String normalized = baseUrl;
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }

    /**
     * Performs an authorized HTTP GET and deserializes the JSON body to a class.
     * @param httpClient Shared HTTP client.
     * @param url URL to request.
     * @param accessToken Bearer token.
     * @param responseType Target response class.
     * @param <T> Response type parameter.
     * @return Parsed response object.
     * @throws Exception When the request fails or JSON parsing fails.
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
     * Performs an authorized HTTP GET and reads the raw binary response.
     * @param httpClient Shared HTTP client.
     * @param url URL to request.
     * @param accessToken Bearer token.
     * @return Binary response bytes.
     * @throws Exception When the request fails or stream reading fails.
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
                    : EntityUtils.toString(response.getEntity(), "UTF-8");
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
     * Executes an authorized GET request and returns the response body as UTF-8 text.
     * @param httpClient Shared HTTP client.
     * @param url URL to request.
     * @param accessToken Bearer token.
     * @return Response body text.
     * @throws Exception When the request fails.
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
                : EntityUtils.toString(response.getEntity(), "UTF-8");

            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "GET " + url + " failed: HTTP " + statusCode + " - " + responseBody
                );
            }

            return responseBody;
        }
    }

    /**
     * Builds the review summation endpoint URL.
     * @param reviewApiUrl Base review API URL with no trailing slash.
     * @return Fully qualified review summation URL.
     */
    private static String buildReviewSummationUrl(String reviewApiUrl) {
        if (reviewApiUrl.endsWith("/v6")) {
            return reviewApiUrl + "/reviews/summations";
        }
        return reviewApiUrl + "/v6/reviews/summations";
    }

    /**
     * Posts a review summation record to review-api-v6.
     * @param httpClient Shared HTTP client.
     * @param reviewApiUrl Review API base URL.
     * @param accessToken Bearer token.
     * @param reviewSummation Review summation payload.
     * @throws Exception When the API call fails.
     */
    private static void postReviewSummation(
        CloseableHttpClient httpClient,
        String reviewApiUrl,
        String accessToken,
        ReviewSummationRequest reviewSummation
    ) throws Exception {
        String url = buildReviewSummationUrl(reviewApiUrl);
        String payload = OBJECT_MAPPER.writeValueAsString(reviewSummation);

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
     * Writes tester JAR bytes to a deterministic tmp path.
     * @param testerConfigId Marathon match configuration ID.
     * @param jarBytes Compiled tester jar bytes.
     * @return Path to the saved JAR file.
     * @throws IOException When file writing fails.
     */
    private static Path writeTesterJar(String testerConfigId, byte[] jarBytes)
        throws IOException {
        Path jarPath = Paths.get("/tmp/tester-" + testerConfigId + ".jar");
        Files.write(jarPath, jarBytes);
        return jarPath;
    }

    /**
     * Builds the scorer config consumed by tester runTester(String, ScorerConfig).
     * @param config Marathon match config response.
     * @param tester Tester response containing class name.
     * @param reviewTypeId Review type ID for review submission.
     * @return ScorerConfig object for tester execution.
     */
    private static ScorerConfig buildScorerConfig(
        MarathonMatchConfigResponse config,
        TesterResponse tester,
        String reviewTypeId
    ) {
        ScorerConfig scorerConfig = new ScorerConfig();
        scorerConfig.setName(config.getId());
        scorerConfig.setTesterClass(tester.getClassName());
        scorerConfig.setScoreCardId(config.getReviewScorecardId());
        scorerConfig.setReviewerId(UUID.randomUUID().toString());
        scorerConfig.setTypeId(reviewTypeId);
        return scorerConfig;
    }

    /**
     * Loads tester class from downloaded JAR and invokes runTester(String, ScorerConfig).
     * @param testerClassName Fully qualified tester class name.
     * @param submissionDir Local submission extraction path.
     * @param scorerConfig Scorer config passed to tester.
     * @param testerJarPath Local tester jar path.
     * @return Computed score.
     * @throws Exception When class loading or reflection fails.
     */
    private static double runTester(
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
            Object score = runTesterMethod.invoke(null, submissionDir, scorerConfig);
            if (!(score instanceof Number)) {
                throw new RuntimeException(
                    "runTester returned non-numeric value for class " + testerClassName
                );
            }
            return ((Number) score).doubleValue();
        }
    }

    /**
     * Deletes a file or directory recursively and ignores cleanup failures.
     * @param path Path to delete.
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
     * @param inputStream Input stream to drain.
     * @return All stream bytes.
     * @throws IOException When stream reading fails.
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
     * Payload for review summation creation via /v6/reviews/summations.
     */
    private static class ReviewSummationRequest {
        @JsonProperty("submissionId")
        private final String submissionId;

        @JsonProperty("aggregateScore")
        private final double aggregateScore;

        @JsonProperty("scorecardId")
        private final String scorecardId;

        @JsonProperty("isPassing")
        private final boolean isPassing;

        @JsonProperty("isFinal")
        private final Boolean isFinal;

        @JsonProperty("isProvisional")
        private final Boolean isProvisional;

        @JsonProperty("isExample")
        private final Boolean isExample;

        @JsonProperty("reviewedDate")
        private final String reviewedDate;

        @JsonProperty("metadata")
        private final Map<String, Object> metadata;

        ReviewSummationRequest(
            String submissionId,
            double aggregateScore,
            String scorecardId,
            boolean isPassing,
            Boolean isFinal,
            Boolean isProvisional,
            Boolean isExample,
            Map<String, Object> metadata
        ) {
            this.submissionId = submissionId;
            this.aggregateScore = aggregateScore;
            this.scorecardId = scorecardId;
            this.isPassing = isPassing;
            this.isFinal = isFinal;
            this.isProvisional = isProvisional;
            this.isExample = isExample;
            this.reviewedDate = Instant.now().toString();
            this.metadata = metadata;
        }
    }

    /**
     * Partial marathon match config response used by the ECS runner bootstrap flow.
     */
    @JsonIgnoreProperties(ignoreUnknown = true)
    private static class MarathonMatchConfigResponse {
        @JsonProperty("id")
        private String id;

        @JsonProperty("submissionApiUrl")
        private String submissionApiUrl;

        @JsonProperty("reviewScorecardId")
        private String reviewScorecardId;

        @JsonProperty("testerId")
        private String testerId;

        public String getId() {
            return id;
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
    }

    /**
     * Partial tester response used by the ECS runner to discover tester class name.
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
