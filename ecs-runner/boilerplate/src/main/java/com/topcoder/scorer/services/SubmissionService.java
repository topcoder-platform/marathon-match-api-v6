package com.topcoder.scorer.services;

import org.apache.http.client.methods.HttpGet;
import org.apache.http.client.methods.HttpPatch;
import org.apache.http.client.methods.CloseableHttpResponse;
import org.apache.http.entity.StringEntity;
import org.apache.http.impl.client.CloseableHttpClient;
import org.apache.http.impl.client.HttpClients;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Paths;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

public class SubmissionService {
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

    public Map<String, Object> getSubmission(String submissionId) throws Exception {
        String url = submissionApiUrl + "/submissions/" + submissionId;
        HttpGet get = new HttpGet(url);
        get.setHeader("Authorization", "Bearer " + accessToken);
        try (CloseableHttpResponse response = httpClient.execute(get)) {
            InputStream content = response.getEntity().getContent();
            return objectMapper.readValue(content, Map.class);
        }
    }

    // Confirmed to ignore updating status in forum. This method needs to be updated when it's clarified how implementation will look like.
    public void updateSubmissionStatus(String submissionId, String status) throws Exception {
        System.out.println("(MOCK) Setting submission status to '" + status + "' for " + submissionId);
    }

    /**
     * Downloads the submission zip from the API and extracts it to the target directory.
     * @param submissionId Submission ID
     * @param targetDir Directory to extract the submission to
     * @throws Exception if download or extraction fails
     */
    public void downloadSubmission(String submissionId, String targetDir) throws Exception {
        String url = submissionApiUrl + "/submissions/" + submissionId + "/download";
        HttpGet get = new HttpGet(url);
        get.setHeader("Authorization", "Bearer " + accessToken);
        System.out.println("[DEBUG] Downloading submission zip from: " + url);
        System.out.println("[DEBUG] Authorization header: Bearer " + (accessToken != null ? accessToken.substring(0, Math.min(8, accessToken.length())) + "..." : "null"));
        try (CloseableHttpResponse response = httpClient.execute(get)) {
            int statusCode = response.getStatusLine().getStatusCode();
            System.out.println("[DEBUG] Download response status: " + statusCode);
            if (statusCode != 200) {
                String responseBody = null;
                if (response.getEntity() != null) {
                    try (InputStream errStream = response.getEntity().getContent()) {
                        java.io.ByteArrayOutputStream baos = new java.io.ByteArrayOutputStream();
                        byte[] buffer = new byte[4096];
                        int len;
                        while ((len = errStream.read(buffer)) != -1) {
                            baos.write(buffer, 0, len);
                        }
                        responseBody = baos.toString("UTF-8");
                    } catch (Exception e) {
                        responseBody = "[unreadable]";
                    }
                }
                System.out.println("[DEBUG] Download response body: " + responseBody);
                throw new RuntimeException("Failed to download submission zip: HTTP " + statusCode);
            }
            InputStream zipStream = response.getEntity().getContent();
            unzip(zipStream, targetDir);
        }
    }

    /**
     * Extracts a zip input stream to the target directory.
     * @param zipStream InputStream of the zip file
     * @param targetDir Directory to extract to
     * @throws Exception if extraction fails
     */
    private void unzip(InputStream zipStream, String targetDir) throws Exception {
        java.nio.file.Files.createDirectories(java.nio.file.Paths.get(targetDir));
        try (ZipInputStream zis = new ZipInputStream(zipStream)) {
            ZipEntry entry;
            while ((entry = zis.getNextEntry()) != null) {
                java.nio.file.Path filePath = java.nio.file.Paths.get(targetDir, entry.getName());
                if (entry.isDirectory()) {
                    java.nio.file.Files.createDirectories(filePath);
                } else {
                    java.nio.file.Files.createDirectories(filePath.getParent());
                    try (FileOutputStream fos = new FileOutputStream(filePath.toFile())) {
                        byte[] buffer = new byte[4096];
                        int len;
                        while ((len = zis.read(buffer)) > 0) {
                            fos.write(buffer, 0, len);
                        }
                    }
                }
            }
        }
    }
} 