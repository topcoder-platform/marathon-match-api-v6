package com.topcoder.scorer.models;

import java.util.List;

public class ChallengeConfig {
    private String name;
    private boolean active;
    private List<String> scorers;
    private String submissionApiUrl;
    private String reviewScorecardId;
    private String reviewTypeName;

    public String getName() { return name; }
    public void setName(String name) { this.name = name; }
    public boolean isActive() { return active; }
    public void setActive(boolean active) { this.active = active; }
    public List<String> getScorers() { return scorers; }
    public void setScorers(List<String> scorers) { this.scorers = scorers; }
    public String getSubmissionApiUrl() { return submissionApiUrl; }
    public void setSubmissionApiUrl(String submissionApiUrl) { this.submissionApiUrl = submissionApiUrl; }
    public String getReviewScorecardId() { return reviewScorecardId; }
    public void setReviewScorecardId(String reviewScorecardId) { this.reviewScorecardId = reviewScorecardId; }
    public String getReviewTypeName() { return reviewTypeName; }
    public void setReviewTypeName(String reviewTypeName) { this.reviewTypeName = reviewTypeName; }
} 