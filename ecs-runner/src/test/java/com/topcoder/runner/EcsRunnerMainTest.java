package com.topcoder.runner;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.OutputStream;
import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
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
