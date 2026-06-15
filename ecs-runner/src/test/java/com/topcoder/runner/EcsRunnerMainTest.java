package com.topcoder.runner;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.OutputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
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
    public void buildMemberVisibleTestOutputHidesStdoutAndScoreButShowsStderr()
        throws Exception {
        Method method = EcsRunnerMain.class.getDeclaredMethod(
            "buildMemberVisibleTestOutput",
            int.class,
            long.class,
            String.class,
            String.class
        );
        method.setAccessible(true);

        String output = (String) method.invoke(
            null,
            3,
            42L,
            "tester error",
            "solution stderr"
        );

        assertTrue(output.contains("Test Case #3:"));
        assertTrue(output.contains("Run Time = 42ms"));
        assertTrue(output.contains("tester error"));
        assertTrue(output.contains("stderr:"));
        assertTrue(output.contains("solution stderr"));
        assertFalse(output.contains("Score ="));
        assertFalse(output.contains("stdout:"));
    }

    @Test
    public void buildInternalReviewArtifactPayloadIncludesPerTestScores()
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

        Map<String, Object> currentReview = new LinkedHashMap<String, Object>();
        currentReview.put("metadata", metadata);

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
            metadata
        );

        Object payloadScores = payload.get("testScores");
        assertTrue(payloadScores instanceof List);
        List<?> scoreList = (List<?>) payloadScores;
        assertEquals(1, scoreList.size());
        assertTrue(scoreList.get(0) instanceof Map);

        Map<?, ?> internalScore = (Map<?, ?>) scoreList.get(0);
        assertEquals("1", internalScore.get("testcase"));
        assertEquals(98.5, ((Number) internalScore.get("score")).doubleValue(), 0.0);
        assertEquals(31L, ((Number) internalScore.get("runTimeMs")).longValue());
        assertFalse(internalScore.containsKey("seed"));
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
