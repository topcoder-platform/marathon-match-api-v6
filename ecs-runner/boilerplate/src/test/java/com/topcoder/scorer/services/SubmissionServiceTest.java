package com.topcoder.scorer.services;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import com.sun.net.httpserver.HttpServer;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.atomic.AtomicReference;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;
import org.junit.After;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/**
 * Verifies submission downloads performed by the ECS runner's shared scorer service.
 */
public class SubmissionServiceTest {
    private static final String ACCESS_TOKEN = "runner-access-token";
    private static final String SUBMISSION_ID = "submission-123";

    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    private HttpServer apiServer;
    private HttpServer storageServer;
    private AtomicReference<String> apiAuthorization;
    private AtomicReference<String> storageAuthorization;

    /**
     * Starts separate API and storage origins for each test.
     * @throws Exception when a local server or ZIP fixture cannot be created.
     */
    @Before
    public void setUp() throws Exception {
        apiAuthorization = new AtomicReference<String>();
        storageAuthorization = new AtomicReference<String>();
        byte[] zipBytes = createZip("solution.txt", "redirected submission");

        storageServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        storageServer.createContext(
            "/submission.zip",
            exchange -> {
                storageAuthorization.set(
                    exchange.getRequestHeaders().getFirst("Authorization")
                );
                exchange.sendResponseHeaders(200, zipBytes.length);
                try (OutputStream body = exchange.getResponseBody()) {
                    body.write(zipBytes);
                }
            }
        );
        storageServer.start();

        apiServer = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        apiServer.createContext(
            "/submissions/" + SUBMISSION_ID + "/download",
            exchange -> {
                apiAuthorization.set(
                    exchange.getRequestHeaders().getFirst("Authorization")
                );
                exchange.getResponseHeaders().set(
                    "Location",
                    serverUrl(storageServer) + "/submission.zip"
                );
                exchange.sendResponseHeaders(302, -1);
                exchange.close();
            }
        );
        apiServer.createContext(
            "/validation.zip",
            exchange -> {
                apiAuthorization.set(
                    exchange.getRequestHeaders().getFirst("Authorization")
                );
                exchange.sendResponseHeaders(200, zipBytes.length);
                try (OutputStream body = exchange.getResponseBody()) {
                    body.write(zipBytes);
                }
            }
        );
        apiServer.start();
    }

    /**
     * Stops local HTTP servers after each test.
     */
    @After
    public void tearDown() {
        if (apiServer != null) {
            apiServer.stop(0);
        }
        if (storageServer != null) {
            storageServer.stop(0);
        }
    }

    /**
     * Confirms that a signed-download redirect is followed without leaking the API bearer token.
     * @throws Exception when the download or extraction fails.
     */
    @Test
    public void followsRedirectWithoutForwardingAuthorization() throws Exception {
        Path targetDirectory = temporaryFolder.newFolder("submission").toPath();
        SubmissionService service = new SubmissionService(
            serverUrl(apiServer),
            ACCESS_TOKEN
        );

        service.downloadSubmission(SUBMISSION_ID, targetDirectory.toString());

        assertEquals("Bearer " + ACCESS_TOKEN, apiAuthorization.get());
        assertNull(storageAuthorization.get());
        assertEquals(
            "redirected submission",
            new String(
                Files.readAllBytes(targetDirectory.resolve("solution.txt")),
                StandardCharsets.UTF_8
            )
        );
    }

    /**
     * Confirms that protected validation downloads still accept a direct ZIP response.
     * @throws Exception when the download or extraction fails.
     */
    @Test
    public void downloadsDirectResponseWithAuthorization() throws Exception {
        Path targetDirectory = temporaryFolder.newFolder("validation").toPath();
        SubmissionService service = new SubmissionService(
            serverUrl(apiServer),
            ACCESS_TOKEN
        );

        service.downloadSubmissionFromUrl(
            serverUrl(apiServer) + "/validation.zip",
            targetDirectory.toString(),
            SUBMISSION_ID
        );

        assertEquals("Bearer " + ACCESS_TOKEN, apiAuthorization.get());
        assertEquals(
            "redirected submission",
            new String(
                Files.readAllBytes(targetDirectory.resolve("solution.txt")),
                StandardCharsets.UTF_8
            )
        );
    }

    /**
     * Creates a ZIP archive containing one UTF-8 text file.
     * @param entryName ZIP entry name.
     * @param contents Text stored in the entry.
     * @return ZIP archive bytes.
     * @throws IOException when the archive cannot be written.
     */
    private byte[] createZip(String entryName, String contents) throws IOException {
        ByteArrayOutputStream output = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(output)) {
            zip.putNextEntry(new ZipEntry(entryName));
            zip.write(contents.getBytes(StandardCharsets.UTF_8));
            zip.closeEntry();
        }
        return output.toByteArray();
    }

    /**
     * Builds the HTTP origin for a bound local server.
     * @param server Bound HTTP server.
     * @return Server origin URL.
     */
    private String serverUrl(HttpServer server) {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }
}
