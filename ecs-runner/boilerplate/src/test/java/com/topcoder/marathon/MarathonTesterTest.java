package com.topcoder.marathon;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class MarathonTesterTest {
    @Test
    public void runTestMarksTimeoutWhenElapsedTimeExceedsLimitAfterRunReturns() {
        FallbackTimeoutTester tester = new FallbackTimeoutTester(15L);
        tester.setParameters(new Parameters());
        tester.setTimeLimit(1L);

        double score = tester.runTest();

        assertTrue(tester.isTimeout());
        assertTrue(tester.timeoutCallbackCalled);
        assertEquals(tester.getErrorScore(), score, 0.0);
        assertTrue(tester.getRunTime() >= 1L);
        assertTrue(tester.getExecutionsErrors().contains("TIMEOUT! Time limit of 1 ms exceeded."));
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
}
