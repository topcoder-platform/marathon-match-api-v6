package com.topcoder.scorer.models;

public class PhaseConfig {
    private String name;
    private String reviewTypeId;
    private String scoreCardId;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public String getReviewTypeId() { return reviewTypeId; }
    public void setReviewTypeId(String reviewTypeId) { this.reviewTypeId = reviewTypeId; }
    public String getScoreCardId() { return scoreCardId; }
    public void setScoreCardId(String scoreCardId) { this.scoreCardId = scoreCardId; }
} 