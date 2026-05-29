import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export interface SubmissionScoringCompletionEmailDetails {
  challengeId: string;
  challengeName: string;
  submissionId: string;
  memberHandle: string;
  aggregateExampleScore: number;
  aggregateProvisionalScore: number;
}

interface EventBusMessage<T> {
  topic: string;
  originator: string;
  timestamp: string;
  'mime-type': string;
  payload: T;
}

interface EventBusEmailPayload {
  from: string;
  replyTo: string;
  recipients: string[];
  data: Record<string, unknown>;
  sendgrid_template_id: string;
  version: string;
}

interface NotificationReservation {
  id: string;
}

/**
 * Sends one marathon scoring completion email through Topcoder Bus API after
 * both example and provisional scores are available for a submission.
 */
@Injectable()
export class ScoringCompletionEmailService {
  private readonly logger = LoggerService.forRoot(
    'ScoringCompletionEmailService',
  );

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Sends the completion email if the template is configured and this
   * submission has not already produced a successful notification.
   * @param token M2M token used for member-api-v6 and Bus API calls.
   * @param details Submission, challenge, member, and score values for the email.
   * @returns Resolves after the email is sent, skipped, or marked failed.
   */
  async sendSubmissionScoringCompleteEmail(
    token: string,
    details: SubmissionScoringCompletionEmailDetails,
  ): Promise<void> {
    const sendgridTemplateId = this.getSendgridTemplateId();
    if (!sendgridTemplateId) {
      this.logger.warn(
        'Skipping Marathon Match scoring completion email because SENDGRID_TEMPLATE_ID_SCORING_COMPLETE is not configured.',
      );
      return;
    }

    const reservation = await this.reserveNotification(
      details.challengeId,
      details.submissionId,
    );
    if (!reservation) {
      return;
    }

    try {
      const recipientEmail = await this.fetchMemberEmail(
        token,
        details.memberHandle,
      );
      if (!recipientEmail) {
        throw new Error(
          `Member ${details.memberHandle} does not have an email returned by member-api-v6.`,
        );
      }

      await this.postEventBusMessage(
        token,
        this.buildEmailPayload(details, recipientEmail, sendgridTemplateId),
      );
      await this.markNotificationSent(
        reservation.id,
        details.memberHandle,
        recipientEmail,
      );

      this.logger.log({
        message: 'Sent Marathon Match scoring completion email.',
        challengeId: details.challengeId,
        submissionId: details.submissionId,
        memberHandle: details.memberHandle,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.markNotificationFailed(reservation.id, errorMessage);
      this.logger.error({
        message: 'Failed to send Marathon Match scoring completion email.',
        challengeId: details.challengeId,
        submissionId: details.submissionId,
        memberHandle: details.memberHandle,
        error: errorMessage,
      });
    }
  }

  /**
   * Reads the SendGrid template ID for scoring completion notifications.
   * @returns Configured SendGrid template ID, if present.
   */
  private getSendgridTemplateId(): string | undefined {
    return this.asString(process.env.SENDGRID_TEMPLATE_ID_SCORING_COMPLETE);
  }

  /**
   * Reserves the notification row so concurrent scorer callbacks cannot send
   * duplicate completion emails.
   * @param challengeId Challenge identifier.
   * @param submissionId Submission identifier.
   * @returns Reservation row when this worker should send, otherwise undefined.
   */
  private async reserveNotification(
    challengeId: string,
    submissionId: string,
  ): Promise<NotificationReservation | undefined> {
    const rows = await this.prisma.$queryRaw<NotificationReservation[]>(
      Prisma.sql`
        INSERT INTO "marathon_match"."scoringCompletionEmailNotification"
          ("challengeId", "submissionId", "status", "createdAt", "updatedAt")
        VALUES (${challengeId}, ${submissionId}, 'PROCESSING', NOW(), NOW())
        ON CONFLICT ("challengeId", "submissionId") DO UPDATE
        SET
          "status" = 'PROCESSING',
          "updatedAt" = NOW(),
          "errorMessage" = NULL
        WHERE
          "scoringCompletionEmailNotification"."status" = 'FAILED'
          OR (
            "scoringCompletionEmailNotification"."status" = 'PROCESSING'
            AND "scoringCompletionEmailNotification"."updatedAt" < NOW() - INTERVAL '15 minutes'
          )
        RETURNING "id"
      `,
    );

    return rows[0];
  }

  /**
   * Marks the reserved notification as sent.
   * @param notificationId Notification marker ID.
   * @param memberHandle Member handle used for the email lookup.
   * @param recipientEmail Email address sent to Bus API.
   * @returns Resolves after the marker is updated.
   */
  private async markNotificationSent(
    notificationId: string,
    memberHandle: string,
    recipientEmail: string,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE "marathon_match"."scoringCompletionEmailNotification"
        SET
          "memberHandle" = ${memberHandle},
          "recipientEmail" = ${recipientEmail},
          "status" = 'SENT',
          "sentAt" = NOW(),
          "updatedAt" = NOW(),
          "errorMessage" = NULL
        WHERE "id" = ${notificationId}
      `,
    );
  }

  /**
   * Marks the reserved notification as failed so a later callback can retry it.
   * @param notificationId Notification marker ID.
   * @param errorMessage Error message to store for diagnostics.
   * @returns Resolves after the marker is updated.
   */
  private async markNotificationFailed(
    notificationId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.prisma.$executeRaw(
      Prisma.sql`
        UPDATE "marathon_match"."scoringCompletionEmailNotification"
        SET
          "status" = 'FAILED',
          "errorMessage" = ${errorMessage},
          "updatedAt" = NOW()
        WHERE "id" = ${notificationId}
      `,
    );
  }

  /**
   * Fetches the competitor email from member-api-v6 by handle.
   * @param token M2M token authorized for member-api-v6.
   * @param memberHandle Member handle to look up.
   * @returns Email address when member-api-v6 returns one.
   */
  private async fetchMemberEmail(
    token: string,
    memberHandle: string,
  ): Promise<string | undefined> {
    const response = await firstValueFrom(
      this.httpService.get(this.buildMemberUrl(memberHandle), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          fields: 'handle,email',
        },
      }),
    );

    return this.asString(this.extractMemberRecord(response.data).email);
  }

  /**
   * Posts the email action payload to Topcoder Bus API.
   * @param token M2M token authorized for Bus API.
   * @param payload Email action payload.
   * @returns Resolves after Bus API accepts the event.
   * @throws Error when Bus API returns a non-success status.
   */
  private async postEventBusMessage(
    token: string,
    payload: EventBusEmailPayload,
  ): Promise<void> {
    const response = await firstValueFrom(
      this.httpService.post(
        this.buildBusEventsUrl(),
        {
          topic: 'external.action.email',
          originator: 'marathon-match-api-v6',
          timestamp: new Date().toISOString(),
          'mime-type': 'application/json',
          payload,
        } satisfies EventBusMessage<EventBusEmailPayload>,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        },
      ),
    );

    if (![200, 202, 204].includes(response.status)) {
      throw new Error(`Bus API status code: ${response.status}`);
    }
  }

  /**
   * Builds the email payload expected by the `external.action.email` topic.
   * @param details Submission, challenge, member, and score values.
   * @param recipientEmail Email address to receive the notification.
   * @param sendgridTemplateId SendGrid dynamic template ID.
   * @returns Event bus email payload.
   */
  private buildEmailPayload(
    details: SubmissionScoringCompletionEmailDetails,
    recipientEmail: string,
    sendgridTemplateId: string,
  ): EventBusEmailPayload {
    const challengeUrl = this.buildChallengeUrl(details.challengeId);
    const fromEmail = this.getEmailFromAddress();

    return {
      from: fromEmail,
      replyTo: fromEmail,
      recipients: [recipientEmail],
      data: {
        memberHandle: details.memberHandle,
        submissionId: details.submissionId,
        challengeName: details.challengeName,
        challengeId: details.challengeId,
        challengeUrl,
        challengeURL: challengeUrl,
        aggregateExampleScore: details.aggregateExampleScore,
        aggregateProvisionalScore: details.aggregateProvisionalScore,
      },
      sendgrid_template_id: sendgridTemplateId,
      version: 'v3',
    };
  }

  /**
   * Builds the public challenge URL included in the email template data.
   * @param challengeId Challenge identifier.
   * @returns Public Topcoder challenge URL.
   */
  private buildChallengeUrl(challengeId: string): string {
    return `https://topcoder.com/challenges/${encodeURIComponent(challengeId)}`;
  }

  /**
   * Resolves the sender address for Bus API email events.
   * @returns Sender email address.
   */
  private getEmailFromAddress(): string {
    return (
      this.asString(process.env.TC_EMAIL_FROM_EMAIL) ??
      this.asString(process.env.EMAIL_FROM) ??
      'no-reply@topcoder.com'
    );
  }

  /**
   * Builds the member-api-v6 URL for one handle.
   * @param memberHandle Member handle to encode into the URL.
   * @returns Absolute member API URL.
   */
  private buildMemberUrl(memberHandle: string): string {
    const rawBase = (
      process.env.MEMBER_API_URL || 'https://api.topcoder-dev.com/v6'
    )
      .replace(/\/+$/, '')
      .replace(/\/members$/, '');
    const baseUrl = rawBase.endsWith('/v6') ? rawBase : `${rawBase}/v6`;
    return `${baseUrl}/members/${encodeURIComponent(memberHandle)}`;
  }

  /**
   * Builds the Bus API event endpoint URL.
   * @returns Absolute Bus API event endpoint URL.
   */
  private buildBusEventsUrl(): string {
    const rawUrl = (
      process.env.BUS_EVENTS_URL ||
      process.env.BUS_API_URL ||
      process.env.BUSAPI_URL ||
      'https://api.topcoder-dev.com/v5'
    ).replace(/\/+$/, '');

    if (rawUrl.endsWith('/bus/events') || rawUrl.endsWith('/eventBus')) {
      return rawUrl;
    }
    if (rawUrl.endsWith('/v5')) {
      return `${rawUrl}/bus/events`;
    }
    return `${rawUrl}/v5/bus/events`;
  }

  /**
   * Extracts a member object from direct and wrapped member-api-v6 responses.
   * @param data Raw response body from member-api-v6.
   * @returns Member record or an empty object.
   */
  private extractMemberRecord(data: unknown): Record<string, unknown> {
    const direct = this.asRecord(data);
    if (Object.keys(direct).length === 0) {
      return {};
    }

    const result = this.asRecord(direct.result);
    if (Object.keys(result).length > 0) {
      return result;
    }

    const dataRecord = this.asRecord(direct.data);
    if (Object.keys(dataRecord).length > 0) {
      return dataRecord;
    }

    return direct;
  }

  /**
   * Safely clones record-like values and rejects arrays.
   * @param value Raw value to normalize.
   * @returns Record value or an empty object.
   */
  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return { ...(value as Record<string, unknown>) };
  }

  /**
   * Converts strings, numbers, and bigint values into trimmed strings.
   * @param value Raw value to convert.
   * @returns Trimmed string or undefined.
   */
  private asString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'bigint'
    ) {
      return undefined;
    }

    const stringValue = `${value}`.trim();
    return stringValue.length > 0 ? stringValue : undefined;
  }
}
