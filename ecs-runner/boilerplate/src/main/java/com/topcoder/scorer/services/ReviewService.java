package com.topcoder.scorer.services;

import org.apache.http.client.methods.HttpPost;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import org.apache.http.HttpResponse;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.Map;

/**
 * Service for posting reviews (scores) to the Submission API.
 */
public class ReviewService {
    private final String submissionApiUrl;
    private final String accessToken;
    private final CloseableHttpClient httpClient;
    private final ObjectMapper objectMapper;

    public ReviewService(String submissionApiUrl, String accessToken) {
        this.submissionApiUrl = submissionApiUrl;
        this.accessToken = accessToken;
        this.httpClient = HttpClients.createDefault();
        this.objectMapper = new ObjectMapper();
    }

    /**
     * Posts a review (score) to the Submission API.
     * @param submissionId Submission ID
     * @param score The computed score
     * @param status Review status (e.g., "completed")
     * @param metadata Optional metadata
     * @param scoreCardId Scorecard ID
     * @param reviewerId Reviewer ID
     * @param typeId Review type ID
     * @throws Exception if the API call fails
     */
    public void createReview(String submissionId, double score, String status, Object metadata,
                             String scoreCardId, String reviewerId, String typeId) throws Exception {
        String url = submissionApiUrl + "/reviews";
        Map<String, Object> body = buildReviewPayload(submissionId, score, status, metadata, scoreCardId, reviewerId, typeId);
        String payload = objectMapper.writeValueAsString(body);
        System.out.println("[ReviewService] Posting to /reviews with payload: " + payload);
        HttpPost post = new HttpPost(url);
        post.setHeader("Authorization", "Bearer " + accessToken);
        post.setHeader("Content-Type", "application/json");
        post.setEntity(new StringEntity(payload));
        try {
            HttpResponse response = httpClient.execute(post);
            int statusCode = response.getStatusLine().getStatusCode();
            System.out.println("[ReviewService] Create review response status: " + statusCode);
            if (response.getEntity() != null) {
                String responseBody = new java.util.Scanner(response.getEntity().getContent()).useDelimiter("\\A").next();
                System.out.println("[ReviewService] Create review response body: " + responseBody);
            }
            if (statusCode < 200 || statusCode >= 300) {
                System.err.println("[ReviewService] Failed to create review: HTTP " + statusCode);
                throw new RuntimeException("Failed to create review: HTTP " + statusCode);
            }
        } catch (Exception e) {
            System.err.println("[ReviewService] Error posting review: " + e.getMessage());
            throw e;
        }
    }

    /**
     * Builds the review payload for the API.
     * @return Map representing the review payload
     */
    private Map<String, Object> buildReviewPayload(String submissionId, double score, String status, Object metadata,
                                                  String scoreCardId, String reviewerId, String typeId) {
        Map<String, Object> body = new HashMap<>();
        body.put("submissionId", submissionId);
        body.put("scoreCardId", scoreCardId);
        body.put("reviewerId", reviewerId);
        body.put("metadata", metadata);
        body.put("typeId", typeId);
        body.put("score", score);
        body.put("status", status);
        return body;
    }
} 