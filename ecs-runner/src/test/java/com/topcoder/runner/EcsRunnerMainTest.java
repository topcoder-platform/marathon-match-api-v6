package com.topcoder.runner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class EcsRunnerMainTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void createPublicArtifactZipAllowsOutputWithinLimit() throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path outputPath = artifactsDir.resolve("public").resolve("output.txt");
        writeRepeatedBytes(outputPath, 1024L);

        Path zipPath = invokeCreatePublicArtifactZip(artifactsDir);

        assertNotNull(zipPath);
        assertTrue(Files.isRegularFile(zipPath));
        Files.deleteIfExists(zipPath);
    }

    @Test
    public void createPublicArtifactZipRejectsOversizedOutput() throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path outputPath = artifactsDir.resolve("public").resolve("output.txt");
        writeRepeatedBytes(outputPath, getMaxOutputBytes() + 1L);

        try {
            invokeCreatePublicArtifactZip(artifactsDir);
            fail("Expected oversized output to be rejected.");
        } catch (InvocationTargetException error) {
            Throwable cause = error.getCause();
            assertTrue(cause instanceof RuntimeException);
            assertTrue(cause.getMessage().contains("Output size limit exceeded"));
            assertTrue(cause.getMessage().contains("public/output.txt"));
        }
    }

    @Test
    public void createMemberVisibleArtifactZipSkipsProvisionalArtifacts()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path outputPath = artifactsDir.resolve("public").resolve("output.txt");
        writeRepeatedBytes(outputPath, 1024L);

        Path zipPath = invokeCreateMemberVisibleArtifactZip(
            artifactsDir,
            "provisional"
        );

        assertNull(zipPath);
    }

    @Test
    public void createMemberVisibleArtifactZipAllowsExampleArtifacts()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path outputPath = artifactsDir.resolve("public").resolve("output.txt");
        writeRepeatedBytes(outputPath, 1024L);

        Path zipPath = invokeCreateMemberVisibleArtifactZip(
            artifactsDir,
            "example"
        );

        assertNotNull(zipPath);
        assertTrue(Files.isRegularFile(zipPath));
        Files.deleteIfExists(zipPath);
    }

    @Test
    public void buildMemberVisibleTestOutputShowsSeedAndScoreButHidesStdout()
        throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "buildMemberVisibleTestOutput",
            int.class,
            long.class,
            double.class,
            long.class,
            String.class,
            String.class
        );
        method.setAccessible(true);

        String output = (String) method.invoke(
            null,
            3,
            12345L,
            98.5,
            42L,
            "tester error",
            "solution stderr"
        );

        assertTrue(output.contains("Test Case #3:"));
        assertTrue(output.contains("Seed = 12345"));
        assertTrue(output.contains("Score = 98.5"));
        assertTrue(output.contains("Run Time = 42ms"));
        assertTrue(output.contains("tester error"));
        assertTrue(output.contains("stderr:"));
        assertTrue(output.contains("solution stderr"));
        assertFalse(output.contains("stdout:"));
    }

    @Test
    public void writePreResultMemberOutputLeavesCompilationInCompileLogOnFailure()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path outputPath = artifactsDir.resolve("public").resolve("output.txt");
        Path compileLogPath = artifactsDir.resolve("public").resolve("compile_log.txt");
        Files.write(
            compileLogPath,
            "$ g++ Solution.cpp\ncompile failed\nExit code: 1\n".getBytes(
                StandardCharsets.UTF_8
            )
        );

        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "writePreResultMemberOutput",
            Path.class,
            Throwable.class
        );
        method.setAccessible(true);
        method.invoke(
            null,
            outputPath,
            new RuntimeException("C++ compilation failed.")
        );

        String output = new String(Files.readAllBytes(outputPath), StandardCharsets.UTF_8);
        String compileLog = new String(
            Files.readAllBytes(compileLogPath),
            StandardCharsets.UTF_8
        );
        assertFalse(output.contains("Compilation Output:"));
        assertFalse(output.contains("compile failed"));
        assertTrue(output.contains("Runner Error:"));
        assertTrue(output.contains("C++ compilation failed."));
        assertTrue(compileLog.contains("compile failed"));
    }

    @Test
    public void buildInternalReviewArtifactPayloadIncludesSeededMetadataTestScores()
        throws Exception {
        Map<String, Object> scoreEntry = new LinkedHashMap<String, Object>();
        scoreEntry.put("testcase", "1");
        scoreEntry.put("seed", 12345L);
        scoreEntry.put("score", 98.5);
        scoreEntry.put("runTimeMs", 31L);

        List<Map<String, Object>> testScores =
            new ArrayList<Map<String, Object>>();
        testScores.add(scoreEntry);

        Map<String, Object> metadata = new LinkedHashMap<String, Object>();
        metadata.put("testScores", testScores);
        metadata.put("compilationOutput", "$ javac Solution.java\nExit code: 0");

        Map<String, Object> currentReview = new LinkedHashMap<String, Object>();
        currentReview.put("metadata", metadata);

        Map<String, Object> callbackScoreEntry = new LinkedHashMap<String, Object>();
        callbackScoreEntry.put("score", 98.5);
        callbackScoreEntry.put("runTimeMs", 31L);
        callbackScoreEntry.put("testcase", "1");
        List<Map<String, Object>> callbackTestScores =
            new ArrayList<Map<String, Object>>();
        callbackTestScores.add(callbackScoreEntry);

        Map<String, Object> callbackMetadata = new LinkedHashMap<String, Object>();
        callbackMetadata.put("testScores", callbackTestScores);

        Object testerExecution = createTesterExecutionResult(
            98.5,
            metadata,
            currentReview
        );
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "buildInternalReviewArtifactPayload",
            String.class,
            String.class,
            String.class,
            String.class,
            getTesterExecutionResultClass(),
            Map.class
        );
        method.setAccessible(true);

        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) method.invoke(
            null,
            "submission-id",
            "provisional",
            "review-type-id",
            "scorecard-id",
            testerExecution,
            callbackMetadata
        );

        Object payloadMetadata = payload.get("metadata");
        assertTrue(payloadMetadata instanceof Map);
        assertEquals(
            "$ javac Solution.java\nExit code: 0",
            ((Map<?, ?>) payloadMetadata).get("compilationOutput")
        );
        assertEquals(
            "$ javac Solution.java\nExit code: 0",
            payload.get("compilationOutput")
        );
        Object payloadMetadataScores = ((Map<?, ?>) payloadMetadata).get("testScores");
        assertTrue(payloadMetadataScores instanceof List);
        List<?> metadataScoreList = (List<?>) payloadMetadataScores;
        assertEquals(1, metadataScoreList.size());
        assertTrue(metadataScoreList.get(0) instanceof Map);

        Map<?, ?> metadataScore = (Map<?, ?>) metadataScoreList.get(0);
        assertEquals("1", metadataScore.get("testcase"));
        assertEquals(12345L, ((Number) metadataScore.get("seed")).longValue());
        assertEquals(98.5, ((Number) metadataScore.get("score")).doubleValue(), 0.0);
        assertEquals(31L, ((Number) metadataScore.get("runTimeMs")).longValue());

        Object payloadScores = payload.get("testScores");
        assertTrue(payloadScores instanceof List);
        List<?> scoreList = (List<?>) payloadScores;
        assertEquals(1, scoreList.size());
        assertTrue(scoreList.get(0) instanceof Map);

        Map<?, ?> internalScore = (Map<?, ?>) scoreList.get(0);
        assertEquals("1", internalScore.get("testcase"));
        assertEquals(12345L, ((Number) internalScore.get("seed")).longValue());
        assertEquals(98.5, ((Number) internalScore.get("score")).doubleValue(), 0.0);
        assertEquals(31L, ((Number) internalScore.get("runTimeMs")).longValue());
    }

    @Test
    public void buildCallbackMetadataOmitsCompilationOutput() throws Exception {
        Map<String, Object> metadata = new LinkedHashMap<String, Object>();
        metadata.put("compilationOutput", "$ g++ Solution.cpp\nExit code: 0");
        metadata.put("testScores", new ArrayList<Map<String, Object>>());

        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "buildCallbackMetadata",
            Map.class,
            String.class,
            String.class
        );
        method.setAccessible(true);

        @SuppressWarnings("unchecked")
        Map<String, Object> callbackMetadata = (Map<String, Object>) method.invoke(
            null,
            metadata,
            "provisional",
            "review-type-id"
        );

        assertFalse(callbackMetadata.containsKey("compilationOutput"));
        assertEquals("provisional", callbackMetadata.get("testProcess"));
        assertEquals("provisional", callbackMetadata.get("testType"));
    }

    @Test
    public void createDirectoryZipIncludesPerSeedStdoutAndStderrArtifacts()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path privateDir = artifactsDir.resolve("private");
        Path stdoutDir = invokePrepareReservedPrivateArtifactDirectory(
            privateDir,
            "stdout"
        );
        Path stderrDir = invokePrepareReservedPrivateArtifactDirectory(
            privateDir,
            "stderr"
        );

        invokeWriteSeedOutputArtifact(stdoutDir, 12345L, "seed stdout\n");
        invokeWriteSeedOutputArtifact(stderrDir, 12345L, "seed stderr\n");

        Path zipPath = invokeCreateDirectoryZip(
            privateDir,
            "submission-id-provisional-internal"
        );

        assertNotNull(zipPath);
        assertEquals("seed stdout\n", readZipEntry(zipPath, "stdout/12345.txt"));
        assertEquals("seed stderr\n", readZipEntry(zipPath, "stderr/12345.txt"));
        Files.deleteIfExists(zipPath);
    }

    @Test
    public void createInternalArtifactZipIncludesPrivateArtifactsAndRunnerLogs()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path privateDir = artifactsDir.resolve("private");
        Files.write(
            privateDir.resolve("reviews.json"),
            "{\"score\":98.5}\n".getBytes(StandardCharsets.UTF_8)
        );
        Files.write(
            artifactsDir.resolve("execution-submission-id.log"),
            "execution log\n".getBytes(StandardCharsets.UTF_8)
        );
        Files.write(
            artifactsDir.resolve("error-submission-id.log"),
            "error log\n".getBytes(StandardCharsets.UTF_8)
        );
        Files.write(
            artifactsDir.resolve("public").resolve("compile_log.txt"),
            "compile log\n".getBytes(StandardCharsets.UTF_8)
        );

        Path zipPath = invokeCreateInternalArtifactZip(artifactsDir);

        assertNotNull(zipPath);
        assertEquals("{\"score\":98.5}\n", readZipEntry(zipPath, "reviews.json"));
        assertEquals(
            "execution log\n",
            readZipEntry(zipPath, "execution-submission-id.log")
        );
        assertEquals("error log\n", readZipEntry(zipPath, "error-submission-id.log"));
        assertEquals("compile log\n", readZipEntry(zipPath, "compile_log.txt"));
        Files.deleteIfExists(zipPath);
    }

    @Test
    public void prepareReservedPrivateArtifactDirectoryClearsExistingContents()
        throws Exception {
        Path artifactsDir = createArtifactsDir();
        Path privateDir = artifactsDir.resolve("private");
        Path stdoutDir = privateDir.resolve("stdout");
        Path staleFile = stdoutDir.resolve("old.txt");
        Files.createDirectories(stdoutDir);
        Files.write(staleFile, "stale".getBytes(StandardCharsets.UTF_8));

        Path preparedDir = invokePrepareReservedPrivateArtifactDirectory(
            privateDir,
            "stdout"
        );

        assertTrue(Files.isDirectory(preparedDir, LinkOption.NOFOLLOW_LINKS));
        assertFalse(Files.exists(staleFile, LinkOption.NOFOLLOW_LINKS));
    }

    @Test
    public void buildRustScorerExecutionCommandEnablesBacktrace()
        throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "buildRustScorerExecutionCommand",
            String.class
        );
        method.setAccessible(true);

        String command = (String) method.invoke(
            null,
            "/tmp/mm-submission-solution/Solution"
        );

        assertEquals(
            "/usr/local/bin/mm-scorer-isolate /usr/bin/env RUST_BACKTRACE=1 "
                + "/tmp/mm-submission-solution/Solution",
            command
        );
    }

    private Path createArtifactsDir() throws Exception {
        Path artifactsDir = temporaryFolder.newFolder("artifacts").toPath();
        Files.createDirectories(artifactsDir.resolve("public"));
        Files.createDirectories(artifactsDir.resolve("private"));
        return artifactsDir;
    }

    private Path invokeCreatePublicArtifactZip(Path artifactsDir) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "createPublicArtifactZip",
            Path.class,
            String.class,
            String.class
        );
        method.setAccessible(true);
        return (Path) method.invoke(
            null,
            artifactsDir,
            "submission-id",
            "submission-id-provisional"
        );
    }

    private Path invokeCreateMemberVisibleArtifactZip(
        Path artifactsDir,
        String testPhase
    ) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "createMemberVisibleArtifactZip",
            Path.class,
            String.class,
            String.class,
            String.class
        );
        method.setAccessible(true);
        return (Path) method.invoke(
            null,
            artifactsDir,
            "submission-id",
            testPhase,
            "submission-id-" + testPhase
        );
    }

    private Path invokeCreateDirectoryZip(
        Path directoryPath,
        String artifactName
    ) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "createDirectoryZip",
            Path.class,
            String.class
        );
        method.setAccessible(true);
        return (Path) method.invoke(null, directoryPath, artifactName);
    }

    private Path invokeCreateInternalArtifactZip(Path artifactsDir) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "createInternalArtifactZip",
            Path.class,
            String.class,
            String.class
        );
        method.setAccessible(true);
        return (Path) method.invoke(
            null,
            artifactsDir,
            "submission-id",
            "submission-id-provisional-internal"
        );
    }

    private Path invokePrepareReservedPrivateArtifactDirectory(
        Path privateDir,
        String directoryName
    ) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "prepareReservedPrivateArtifactDirectory",
            Path.class,
            String.class
        );
        method.setAccessible(true);
        return (Path) method.invoke(null, privateDir, directoryName);
    }

    private void invokeWriteSeedOutputArtifact(
        Path outputDir,
        long seed,
        String outputText
    ) throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "writeSeedOutputArtifact",
            Path.class,
            long.class,
            String.class
        );
        method.setAccessible(true);
        method.invoke(null, outputDir, seed, outputText);
    }

    private String readZipEntry(Path zipPath, String entryName) throws Exception {
        try (ZipFile zipFile = new ZipFile(zipPath.toFile())) {
            ZipEntry entry = zipFile.getEntry(entryName);
            assertNotNull(entry);
            try (InputStream inputStream = zipFile.getInputStream(entry)) {
                ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
                byte[] buffer = new byte[8192];
                int bytesRead;
                while ((bytesRead = inputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, bytesRead);
                }
                return new String(outputStream.toByteArray(), StandardCharsets.UTF_8);
            }
        }
    }

    private Object createTesterExecutionResult(
        double score,
        Map<String, Object> metadata,
        Map<String, Object> currentReview
    ) throws Exception {
        Constructor<?> constructor = getTesterExecutionResultClass()
            .getDeclaredConstructor(double.class, Map.class, Map.class, List.class);
        constructor.setAccessible(true);
        return constructor.newInstance(
            score,
            metadata,
            currentReview,
            new ArrayList<Map<String, Object>>()
        );
    }

    private Class<?> getTesterExecutionResultClass() throws Exception {
        return Class.forName(
            "com.topcoder.runner.EcsRunnerMain$TesterExecutionResult"
        );
    }

    private long getMaxOutputBytes() throws Exception {
        Field field = EcsRunnerMain.class.getDeclaredField("MAX_OUTPUT_BYTES");
        field.setAccessible(true);
        return ((Long) field.get(null)).longValue();
    }

    private void writeRepeatedBytes(Path path, long sizeBytes) throws Exception {
        Files.createDirectories(path.getParent());
        byte[] chunk = new byte[8192];
        Arrays.fill(chunk, (byte) 'A');

        try (OutputStream outputStream = Files.newOutputStream(path)) {
            long remaining = sizeBytes;
            while (remaining > 0L) {
                int bytesToWrite = (int) Math.min(chunk.length, remaining);
                outputStream.write(chunk, 0, bytesToWrite);
                remaining -= bytesToWrite;
            }
        }
    }
}
