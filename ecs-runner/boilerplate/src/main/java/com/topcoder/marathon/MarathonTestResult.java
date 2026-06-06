package com.topcoder.marathon;

public class MarathonTestResult {
    private String error;
    private boolean isMaximize;
    private String output;
    private String stdout;
    private String stderr;
    private long runTime;
    private double score;

    public MarathonTestResult() {
        score = -1;
        output = "";
        stdout = "";
        stderr = "";
        error = "";
        runTime = 0;
        isMaximize = true;
    }

    public String getError() {
        return error;
    }

    public String getOutput() {
        return output;
    }

    /**
     * Returns stdout consumed from the submitted solution.
     *
     * @return Bounded stdout text, including protocol lines read by the tester.
     */
    public String getStdout() {
        return stdout;
    }

    /**
     * Returns stderr consumed from the submitted solution.
     *
     * @return Bounded stderr text captured by the tester harness.
     */
    public String getStderr() {
        return stderr;
    }

    public long getRunTime() {
        return runTime;
    }

    public double getScore() {
        return score;
    }

    public boolean isMaximize() {
        return isMaximize;
    }

    public void setError(String error) {
        this.error = error;
    }

    public void setMaximize(boolean isMaximize) {
        this.isMaximize = isMaximize;
    }

    public void setOutput(String output) {
        this.output = output;
    }

    /**
     * Stores stdout consumed from the submitted solution.
     *
     * @param stdout Bounded stdout text read by the tester.
     */
    public void setStdout(String stdout) {
        this.stdout = stdout == null ? "" : stdout;
    }

    /**
     * Stores stderr consumed from the submitted solution.
     *
     * @param stderr Bounded stderr text read by the tester.
     */
    public void setStderr(String stderr) {
        this.stderr = stderr == null ? "" : stderr;
    }

    public void setRunTime(long runTime) {
        this.runTime = runTime;
    }

    public void setScore(double score) {
        this.score = score;
    }
}
