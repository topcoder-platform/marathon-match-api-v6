package com.topcoder.scorer.services;

import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.client.methods.HttpGet;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Instant;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Service used by ECS runner to read and download submissions from submission-api.
 */
public class SubmissionService {
    private static final int RESPONSE_BODY_PREVIEW_LIMIT = 4000;
    private final CloseableHttpClient httpClient;
    private final ObjectMapper objectMapper;
    private final String submissionApiUrl;
    private final String accessToken;

    public SubmissionService(String submissionApiUrl, String accessToken) {
        this.httpClient = HttpClients.createDefault();
        this.objectMapper = new ObjectMapper();
        this.submissionApiUrl = submissionApiUrl;
        this.accessToken = accessToken;
    }

    /**
     * Loads submission metadata from submission-api.
     * @param submissionId Submission identifier.
     * @return Submission payload map from submission-api.
     * @throws Exception When HTTP request fails or payload cannot be parsed.
     */
    @SuppressWarnings("unchecked")
    public Map<String, Object> getSubmission(String submissionId) throws Exception {
        String url = submissionApiUrl + "/submissions/" + submissionId;
        HttpGet get = new HttpGet(url);
        get.setHeader("Authorization", "Bearer " + accessToken);
        logInfo(submissionId, "GET " + url + " (submission metadata)");
        try (CloseableHttpResponse response = httpClient.execute(get)) {
            int statusCode = response.getStatusLine().getStatusCode();
            String responseBody = readResponseBody(response);
            logInfo(
                submissionId,
                "GET "
                    + url
                    + " returned HTTP "
                    + statusCode
                    + ", bodyPreview="
                    + truncate(responseBody, RESPONSE_BODY_PREVIEW_LIMIT)
            );
            if (statusCode < 200 || statusCode >= 300) {
                throw new RuntimeException(
                    "Failed to fetch submission metadata: HTTP "
                        + statusCode
                        + ", body="
                        + responseBody
                );
            }
            return objectMapper.readValue(responseBody, Map.class);
        }
    }

    // Confirmed to ignore updating status in forum. This method needs to be updated when it's clarified how implementation will look like.
    public void updateSubmissionStatus(String submissionId, String status) throws Exception {
        logInfo(
            submissionId,
            "(MOCK) Setting submission status to '" + status + "' for " + submissionId
        );
    }

    /**
     * Downloads the submission zip from the API and extracts it to the target directory.
     * @param submissionId Submission ID.
     * @param targetDir Directory to extract the submission to.
     * @throws Exception if download or extraction fails.
     */
    public void downloadSubmission(String submissionId, String targetDir) throws Exception {
        String url = submissionApiUrl + "/submissions/" + submissionId + "/download";
        HttpGet get = new HttpGet(url);
        get.setHeader("Authorization", "Bearer " + accessToken);
        logInfo(submissionId, "GET " + url + " (submission zip download)");
        logInfo(
            submissionId,
            "Authorization token preview: "
                + (accessToken == null
                    ? "<null>"
                    : accessToken.substring(0, Math.min(12, accessToken.length())) + "...")
        );

        try (CloseableHttpResponse response = httpClient.execute(get)) {
            int statusCode = response.getStatusLine().getStatusCode();
            logInfo(submissionId, "Download response status: HTTP " + statusCode);
            if (statusCode != 200) {
                String responseBody = readResponseBody(response);
                logError(
                    submissionId,
                    "Download failed: HTTP "
                        + statusCode
                        + ", body="
                        + truncate(responseBody, RESPONSE_BODY_PREVIEW_LIMIT),
                    null
                );
                throw new RuntimeException(
                    "Failed to download submission zip: HTTP "
                        + statusCode
                        + ", body="
                        + responseBody
                );
            }

            if (response.getEntity() == null) {
                throw new RuntimeException("Submission zip response body is empty.");
            }

            try (InputStream zipStream = response.getEntity().getContent()) {
                unzip(zipStream, targetDir, submissionId);
            }

            logInfo(
                submissionId,
                "Submission zip extracted successfully to " + targetDir
            );
        }
    }

    /**
     * Extracts a zip input stream to the target directory.
     * @param zipStream InputStream of the zip file.
     * @param targetDir Directory to extract to.
     * @param submissionId Submission ID for contextual logs.
     * @throws Exception if extraction fails.
     */
    private void unzip(InputStream zipStream, String targetDir, String submissionId)
        throws Exception {
        Path targetRoot = Paths.get(targetDir).toAbsolutePath().normalize();
        java.nio.file.Files.createDirectories(targetRoot);
        int extractedEntries = 0;
        try (ZipInputStream zis = new ZipInputStream(zipStream)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                Path filePath = targetRoot.resolve(entry.getName()).normalize();
                if (!filePath.startsWith(targetRoot)) {
                    throw new RuntimeException(
                        "Refusing to extract zip entry outside target directory: "
                            + entry.getName()
                    );
                }
                logInfo(
                    submissionId,
                    "Extracting zip entry: " + entry.getName() + " (directory=" + entry.isDirectory() + ")"
                );
                if (entry.isDirectory()) {
                    java.nio.file.Files.createDirectories(filePath);
                } else {
                    Path parent = filePath.getParent();
                    if (parent != null) {
                        java.nio.file.Files.createDirectories(parent);
                    }
                    try (FileOutputStream fos = new FileOutputStream(filePath.toFile())) {
                        byte[] buffer = new byte[4096];
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }
                extractedEntries += 1;
            }
        }
        logInfo(
            submissionId,
            "Extracted " + extractedEntries + " zip entries into " + targetRoot
        );
    }

    /**
     * Reads HTTP response body as UTF-8 text.
     * @param response HTTP response.
     * @return Response body string (empty when entity is missing).
     * @throws IOException when stream read fails.
     */
    private String readResponseBody(CloseableHttpResponse response) throws IOException {
        if (response.getEntity() == null) {
            return "";
        }

        try (InputStream stream = response.getEntity().getContent()) {
            byte[] bytes = readAllBytes(stream);
            return new String(bytes, StandardCharsets.UTF_8);
        }
    }

    /**
     * Reads all bytes from an input stream.
     * @param stream Input stream.
     * @return Stream bytes.
     * @throws IOException when read fails.
     */
    private byte[] readAllBytes(InputStream stream) throws IOException {
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        byte[] buffer = new byte[4096];
        int len;
        while ((len = stream.read(buffer)) != -1) {
            output.write(buffer, 0, len);
        }
        return output.toByteArray();
    }

    /**
     * Truncates text output for logs.
     * @param value Input string.
     * @param maxChars Maximum length.
     * @return Truncated string when needed.
     */
    private String truncate(String value, int maxChars) {
        if (value == null || value.length() <= maxChars) {
            return value == null ? "" : value;
        }
        return value.substring(0, maxChars) + "...<truncated>";
    }

    /**
     * Logs an informational message with submission context.
     * @param submissionId Submission ID.
     * @param message Log message.
     */
    private void logInfo(String submissionId, String message) {
        System.out.println(
            "["
                + Instant.now().toString()
                + "] [INFO] [SubmissionService] [submissionId="
                + submissionId
                + "] "
                + message
        );
    }

    /**
     * Logs an error message with submission context.
     * @param submissionId Submission ID.
     * @param message Log message.
     * @param error Optional error.
     */
    private void logError(String submissionId, String message, Throwable error) {
        System.err.println(
            "["
                + Instant.now().toString()
                + "] [ERROR] [SubmissionService] [submissionId="
                + submissionId
                + "] "
                + message
        );
        if (error != null) {
            error.printStackTrace(System.err);
        }
    }
}
