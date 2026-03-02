/**
 * Kafka payload sent by review-api-v6 when a marathon match submission is ready.
 */
export interface MarathonMatchSubmissionEventPayload {
  submissionId: string;
  challengeId: string;
  submissionUrl: string;
  memberHandle: string;
  memberId: string;
  submittedDate: string;
}
