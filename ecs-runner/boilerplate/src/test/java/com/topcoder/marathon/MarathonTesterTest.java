package com.topcoder.marathon;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

public class MarathonTesterTest {
    @Rule
    public TemporaryFolder temporaryFolder = new TemporaryFolder();

    @Test
    public void runTestMarksTimeoutWhenElapsedTimeExceedsLimitAfterRunReturns() {
        FallbackTimeoutTester tester = new FallbackTimeoutTester(15L);
        tester.setParameters(new Parameters());
        tester.setTimeLimit(1L);

        double score = tester.runTest();

        assertTrue(tester.isTimeout());
        assertTrue(tester.timeoutCallbackCalled);
        assertEquals(tester.getErrorScore(), score, 0.0);
        assertEquals(1L, tester.getRunTime());
        assertTrue(tester.getExecutionsErrors().contains("TIMEOUT! Time limit of 1 ms exceeded."));
    }

    @Test
    public void runTestDoesNotChargeSetupBeforeStartTime() throws Exception {
        SetupBeforeTimingTester tester = new SetupBeforeTimingTester(75L, 5L);
        tester.setParameters(new Parameters());
        tester.setTimeLimit(50L);

        double score = tester.runTest();

        assertFalse(tester.isTimeout());
        assertEquals(100.0, score, 0.0);
        assertTrue(tester.getRunTime() < 50L);
    }

    @Test
    public void runTestDoesNotChargeProcessStartupBeforeMeasuredRead() throws Exception {
        Path script = createDelayedOutputScript(60L, "42");
        Parameters parameters = new Parameters();
        parameters.put(Parameters.exec, script.toString());
        parameters.put(Parameters.noOutput, null);
        ProcessStartupTester tester = new ProcessStartupTester(90L);
        tester.setParameters(parameters);
        tester.setTimeLimit(25L);

        double score = tester.runTest();

        assertFalse(tester.isTimeout());
        assertEquals(100.0, score, 0.0);
        assertTrue(tester.getRunTime() < 25L);
        assertEquals("42\n", tester.getSolutionOutput());
    }

    @Test
    public void runTestClampsProcessTimeoutRuntimeToConfiguredLimit() throws Exception {
        Path script = createDelayedOutputScript(100L, "42");
        Parameters parameters = new Parameters();
        parameters.put(Parameters.exec, script.toString());
        parameters.put(Parameters.noOutput, null);
        ProcessStartupTester tester = new ProcessStartupTester(0L);
        tester.setParameters(parameters);
        tester.setTimeLimit(20L);

        double score = tester.runTest();

        assertTrue(tester.isTimeout());
        assertTrue(tester.timeoutCallbackCalled);
        assertEquals(tester.getErrorScore(), score, 0.0);
        assertEquals(20L, tester.getRunTime());
        assertTrue(tester.getExecutionsErrors().contains("TIMEOUT! Time limit of 20 ms exceeded."));
    }

    private Path createDelayedOutputScript(long delayMillis, String output)
        throws Exception {
        Path script = temporaryFolder
            .newFile("delayed-output-" + delayMillis + ".sh")
            .toPath();
        Files.write(
            script,
            Arrays.asList(
                "#!/bin/sh",
                "sleep " + (delayMillis / 1000.0),
                "printf '" + output + "\\n'"
            ),
            StandardCharsets.UTF_8
        );
        assertTrue(script.toFile().setExecutable(true));
        return script;
    }

    private static final class FallbackTimeoutTester extends MarathonTester {
        private final long sleepMillis;
        private boolean timeoutCallbackCalled;

        private FallbackTimeoutTester(long sleepMillis) {
            this.sleepMillis = sleepMillis;
        }

        @Override
        protected void generate() {
        }

        @Override
        protected boolean isMaximize() {
            return true;
        }

        @Override
        protected double run() throws Exception {
            startTime();
            try {
                Thread.sleep(sleepMillis);
            } finally {
                stopTime();
            }
            return 100.0;
        }

        @Override
        public int getErrorScore() {
            return -1;
        }

        @Override
        protected void timeout() {
            timeoutCallbackCalled = true;
        }
    }

    private static final class SetupBeforeTimingTester extends MarathonTester {
        private final long setupMillis;
        private final long measuredMillis;

        private SetupBeforeTimingTester(long setupMillis, long measuredMillis) {
            this.setupMillis = setupMillis;
            this.measuredMillis = measuredMillis;
        }

        @Override
        protected void generate() {
        }

        @Override
        protected boolean isMaximize() {
            return true;
        }

        @Override
        protected double run() throws Exception {
            Thread.sleep(setupMillis);
            startTime();
            try {
                Thread.sleep(measuredMillis);
            } finally {
                stopTime();
            }
            return 100.0;
        }

        @Override
        public int getErrorScore() {
            return -1;
        }
    }

    private static final class ProcessStartupTester extends MarathonTester {
        private final long setupMillis;
        private boolean timeoutCallbackCalled;

        private ProcessStartupTester(long setupMillis) {
            this.setupMillis = setupMillis;
        }

        @Override
        protected void generate() {
        }

        @Override
        protected boolean isMaximize() {
            return true;
        }

        @Override
        protected double run() throws Exception {
            Thread.sleep(setupMillis);
            startTime();
            try {
                assertEquals("42", readLine());
            } finally {
                stopTime();
            }
            return 100.0;
        }

        @Override
        public int getErrorScore() {
            return -1;
        }

        @Override
        protected void timeout() {
            timeoutCallbackCalled = true;
        }
    }
}
