package com.topcoder.scorer;

import com.topcoder.scorer.services.SubmissionService;
import com.topcoder.scorer.services.ReviewService;
import com.topcoder.scorer.models.ScorerConfig;
import com.topcoder.scorer.models.ChallengeConfig;
import com.topcoder.scorer.models.ScoringResult;
import com.topcoder.scorer.models.PhaseConfig;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.util.EntityUtils;

/**
 * Main entry point for the Java scorer. Orchestrates loading config, running the scorer, and posting the review.
 */
public class ScorerMain {
    public static void main(String[] args) {
        String submissionDir = null;
        try {
            // Log all environment variables for debugging
            System.out.println("[DEBUG] Environment Variables:");
            System.getenv().forEach((k, v) -> {
                if (k.toLowerCase().contains("token")) {
                    System.out.println("  " + k + "=***" + (v.length() > 8 ? v.substring(0, 8) : v) + "... (redacted) ***");
                } else {
                    System.out.println("  " + k + "=" + v);
                }
            });
            Map<String, Object> config = loadConfig();
            // Log key config values
            ChallengeConfig challengeConfig = (ChallengeConfig) config.get("challengeConfig");
            ScorerConfig scorerConfig = (ScorerConfig) config.get("scorerConfig");
            String accessToken = (String) config.get("accessToken");
            String submissionId = (String) config.get("submissionId");
            System.out.println("[DEBUG] challengeConfig.submissionApiUrl: " + challengeConfig.getSubmissionApiUrl());
            System.out.println("[DEBUG] submissionId: " + submissionId);
            System.out.println("[DEBUG] accessToken (first 8 chars): " + (accessToken != null ? accessToken.substring(0, Math.min(8, accessToken.length())) + "..." : "null"));
            submissionDir = downloadSubmission(
                (ChallengeConfig) config.get("challengeConfig"),
                (String) config.get("accessToken"),
                (String) config.get("submissionId")
            );
            for (PhaseConfig phase : scorerConfig.getPhases()) {
                String status = null;
                if ("example".equalsIgnoreCase(phase.getName())) {
                    status = "running examples";
                } else if ("provisional".equalsIgnoreCase(phase.getName())) {
                    status = "running provisional";
                }
                // Confirmed to ignore updating status in forum. This should be updated when implementation is clarified.
                System.out.println("(MOCK) Setting submission status to '" + status + "' for " + submissionId);

                String reviewTypeId = phase.getReviewTypeId();
                String scoreCardId = phase.getScoreCardId();
                if (reviewTypeId == null || reviewTypeId.isEmpty()) {
                    throw new RuntimeException("No review type id found for phase '" + phase.getName() + "'");
                }
                if (scoreCardId == null || scoreCardId.isEmpty()) {
                    throw new RuntimeException("No scoreCardId found for phase '" + phase.getName() + "'");
                }
                System.out.println("[DEBUG] Using reviewTypeId for phase '" + phase.getName() + "': " + reviewTypeId);
                System.out.println("[DEBUG] Using scoreCardId for phase '" + phase.getName() + "': " + scoreCardId);

                double score = runScoring(
                    (String) config.get("testerClassName"),
                    submissionDir,
                    scorerConfig
                );
                createReview(
                    challengeConfig,
                    accessToken,
                    submissionId,
                    score,
                    reviewTypeId,
                    scoreCardId
                );
            }
            // Confirmed to ignore updating status in forum. This should be updated when implementation is clarified.
            System.out.println("(MOCK) Setting submission status to 'completed' for " + submissionId);
            ScoringResult result = new ScoringResult(0, "completed");
            System.out.println(new ObjectMapper().writeValueAsString(result));
        } catch (Exception e) {
            e.printStackTrace();
            System.exit(2);
        } finally {
            if (submissionDir != null) {
                cleanupSubmissionDir(submissionDir);
            }
        }
    }

    /**
     * Loads configuration and environment variables, parses JSON configs.
     * @return Map with challengeConfig, scorerConfig, accessToken, submissionId, testerClassName
     * @throws Exception if parsing fails or env vars are missing
     */
    private static Map<String, Object> loadConfig() throws Exception {
        ObjectMapper mapper = new ObjectMapper();
        String challengeConfigJson = System.getenv("CHALLENGE_CONFIG");
        String scorerConfigJson = System.getenv("SCORER_CONFIG");
        String accessToken = System.getenv("ACCESS_TOKEN");
        String submissionId = System.getenv("SUBMISSION_ID");
        if (challengeConfigJson == null || scorerConfigJson == null || accessToken == null || submissionId == null) {
            throw new IllegalArgumentException("Missing required environment variables.");
        }
        ChallengeConfig challengeConfig = mapper.readValue(challengeConfigJson, ChallengeConfig.class);
        ScorerConfig scorerConfig = mapper.readValue(scorerConfigJson, ScorerConfig.class);
        String testerClassName = scorerConfig.getTesterClass();
        Map<String, Object> config = new HashMap<>();
        config.put("challengeConfig", challengeConfig);
        config.put("scorerConfig", scorerConfig);
        config.put("accessToken", accessToken);
        config.put("submissionId", submissionId);
        config.put("testerClassName", testerClassName);
        return config;
    }

    /**
     * Downloads the submission zip and extracts it to a unique directory for scoring.
     * @param challengeConfig Challenge configuration
     * @param accessToken Access token for API
     * @param submissionId Submission ID
     * @return Path to the extracted submission directory
     * @throws Exception if download or extraction fails
     */
    private static String downloadSubmission(ChallengeConfig challengeConfig, String accessToken, String submissionId) throws Exception {
        SubmissionService submissionService = new SubmissionService(challengeConfig.getSubmissionApiUrl(), accessToken);
        String submissionDir = "/tmp/submission-" + submissionId;
        try {
            submissionService.downloadSubmission(submissionId, submissionDir);
        } catch (Exception e) {
            System.err.println("[ERROR] Failed to download or extract submission: " + e.getMessage());
            java.nio.file.Files.list(java.nio.file.Paths.get("/tmp")).forEach(p -> System.err.println("/tmp contains: " + p));
            throw e;
        }
        return submissionDir;
    }

    /**
     * Cleans up the extracted submission directory after scoring.
     * @param submissionDir Path to the extracted submission directory
     */
    private static void cleanupSubmissionDir(String submissionDir) {
        try {
            java.nio.file.Path dir = java.nio.file.Paths.get(submissionDir);
            if (java.nio.file.Files.exists(dir)) {
                java.nio.file.Files.walk(dir)
                    .sorted(java.util.Comparator.reverseOrder())
                    .map(java.nio.file.Path::toFile)
                    .forEach(java.io.File::delete);
            }
        } catch (Exception e) {
            System.err.println("[WARN] Failed to clean up submission directory: " + e.getMessage());
        }
    }

    /**
     * Runs the scoring logic by invoking the tester class, passing the submission directory.
     * @param testerClassName Fully qualified class name of the tester
     * @param submissionDir Path to the extracted submission directory
     * @param scorerConfig Scorer configuration
     * @return The computed score
     * @throws Exception if scoring fails
     */
    private static double runScoring(String testerClassName, String submissionDir, ScorerConfig scorerConfig) throws Exception {
        Class<?> testerClass = Class.forName(testerClassName);
        Method runTester = testerClass.getMethod("runTester", String.class, ScorerConfig.class);
        return (double) runTester.invoke(null, submissionDir, scorerConfig);
    }

    /**
     * Creates a review by posting the score to the Submission API.
     * @param challengeConfig Challenge configuration
     * @param accessToken Access token for API
     * @param submissionId Submission ID
     * @param score The computed score
     * @param reviewTypeId The review type ID
     * @param scoreCardId The score card ID
     * @throws Exception if review creation fails
     */
    private static void createReview(ChallengeConfig challengeConfig, String accessToken, String submissionId, double score, String reviewTypeId, String scoreCardId) throws Exception {
        ReviewService reviewService = new ReviewService(challengeConfig.getSubmissionApiUrl(), accessToken);
        String reviewerId = java.util.UUID.randomUUID().toString();
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("testType", "provisional");
        System.out.println("Creating review for submission " + submissionId + " with score " + score + ", reviewTypeId " + reviewTypeId + ", scoreCardId " + scoreCardId);
        reviewService.createReview(submissionId, score, "completed", metadata, scoreCardId, reviewerId, reviewTypeId);
    }

    /**
     * Fetches review types from the Submission API.
     * @param submissionApiUrl Submission API URL
     * @param accessToken Access token for API
     * @return List of review types
     * @throws Exception if fetching review types fails
     */
    private static List<Map<String, Object>> fetchReviewTypes(String submissionApiUrl, String accessToken) throws Exception {
        String url = submissionApiUrl + "/reviewTypes";
        System.out.println("[DEBUG] Fetching review types from: " + url);
        HttpGet get = new HttpGet(url);
        get.setHeader("Authorization", "Bearer " + accessToken);
        get.setHeader("Content-Type", "application/json");
        try (CloseableHttpClient httpClient = HttpClients.createDefault()) {
            try (org.apache.http.client.methods.CloseableHttpResponse response = httpClient.execute(get)) {
                int statusCode = response.getStatusLine().getStatusCode();
                String responseBody = EntityUtils.toString(response.getEntity(), "UTF-8");
                System.out.println("[DEBUG] Review types response status: " + statusCode);
                System.out.println("[DEBUG] Review types response body: " + responseBody);
                if (statusCode != 200) {
                    throw new RuntimeException("Failed to fetch review types: HTTP " + statusCode);
                }
                com.fasterxml.jackson.databind.ObjectMapper mapper = new com.fasterxml.jackson.databind.ObjectMapper();
                return mapper.readValue(responseBody, List.class);
            }
        }
    }
} 