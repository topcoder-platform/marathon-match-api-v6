package com.topcoder.scorer.models;

public class ScoringResult {
    private double score;
    private String status;

    public ScoringResult() {}
    public ScoringResult(double score, String status) {
        this.score = score;
        this.status = status;
    }

    public double getScore() { return score; }
    public void setScore(double score) { this.score = score; }
    public String getStatus() { return status; }
    public void setStatus(String status) { this.status = status; }
} 