package com.topcoder.scorer.models;

import java.util.List;

public class ScorerConfig {
    private String name;
    private String testerClass;
    private int timeLimit;
    private int timeout;
    private int compileTimeout;
    private long startSeed;
    private int numberOfTests;
    private String reviewerId;
    private String typeId;
    private String scoreCardId;
    private List<PhaseConfig> phases;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getTesterClass() { return testerClass; }
    public void setTesterClass(String testerClass) { this.testerClass = testerClass; }
    public int getTimeLimit() { return timeLimit; }
    public void setTimeLimit(int timeLimit) { this.timeLimit = timeLimit; }
    public int getTimeout() { return timeout; }
    public void setTimeout(int timeout) { this.timeout = timeout; }
    public int getCompileTimeout() { return compileTimeout; }
    public void setCompileTimeout(int compileTimeout) { this.compileTimeout = compileTimeout; }
    public long getStartSeed() { return startSeed; }
    public void setStartSeed(long startSeed) { this.startSeed = startSeed; }
    public int getNumberOfTests() { return numberOfTests; }
    public void setNumberOfTests(int numberOfTests) { this.numberOfTests = numberOfTests; }
    public String getReviewerId() { return reviewerId; }
    public void setReviewerId(String reviewerId) { this.reviewerId = reviewerId; }
    public String getTypeId() { return typeId; }
    public void setTypeId(String typeId) { this.typeId = typeId; }
    public String getScoreCardId() { return scoreCardId; }
    public void setScoreCardId(String scoreCardId) { this.scoreCardId = scoreCardId; }
    public List<PhaseConfig> getPhases() { return phases; }
    public void setPhases(List<PhaseConfig> phases) { this.phases = phases; }
} 