/**
 * Marathon match submission data sent by review-api-v6 when scoring can begin.
 */
export interface MarathonMatchSubmissionEventPayload {
  submissionId: string;
  challengeId: string;
  submissionUrl: string;
  memberHandle: string;
  memberId: string;
  submittedDate: string;
}

/**
 * Event-bus envelope used by tc-bus/kafka topics.
 */
export interface MarathonMatchSubmissionEventEnvelope {
  topic?: string;
  originator?: string;
  'mime-type'?: string;
  timestamp?: string;
  payload?: MarathonMatchSubmissionEventPayload | null;
}

/**
 * Kafka messages may arrive either as raw payload (manual publish) or wrapped in
 * an event-bus envelope (production publish through tc-bus).
 */
export type MarathonMatchSubmissionKafkaMessage =
  | MarathonMatchSubmissionEventPayload
  | MarathonMatchSubmissionEventEnvelope;
