import { createHash } from 'crypto';
import { Client } from 'pg';
import { LoggerService } from './logger.service';

/**
 * Serializes a member's submission dispatch across Marathon API replicas.
 * The Kafka handler holds this session lock through its newest-submission lookup,
 * cancellation persistence, ECS shutdown, and replacement launch. External calls
 * do not run inside a Prisma transaction.
 * @param challengeId Challenge containing the member's submissions.
 * @param memberId Submitter identity from the validated event.
 * @param work Dispatch operation to execute while holding the lock.
 * @returns The operation result, releasing the lock by closing its connection.
 * @throws Error for missing database configuration, connection/lock failure, or
 * failed dispatch. Failures propagate to Kafka retry handling.
 */
export async function withMemberScorerLock<T>(
  challengeId: string,
  memberId: string,
  work: () => Promise<T>,
): Promise<T> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      'DATABASE_URL is required for the member scorer dispatch lock.',
    );
  }
  const digest = createHash('sha256')
    .update(JSON.stringify(['marathon-member-dispatch', challengeId, memberId]))
    .digest();
  const client = new Client({
    connectionString,
    connectionTimeoutMillis: 5000,
    statement_timeout: 180000,
  });

  try {
    await client.connect();
    await client.query('SELECT pg_advisory_lock($1::integer, $2::integer)', [
      digest.readInt32BE(0),
      digest.readInt32BE(4),
    ]);
    return await work();
  } finally {
    // Closing the dedicated session also releases its advisory locks on failure.
    await client.end().catch((error: unknown) => {
      LoggerService.forRoot('MemberScorerLock').error({
        message: 'Failed to close the member scorer lock connection.',
        challengeId,
        memberId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}
