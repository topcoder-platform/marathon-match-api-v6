import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export type ScoringCompletionStatus = 'pass' | 'fail';

export interface SubmissionScoringCompletionEmailDetails {
  challengeId: string;
  challengeName: string;
  submissionId: string;
  memberHandle?: string;
  memberId?: string;
  userId?: string;
  scoringStatus: ScoringCompletionStatus;
  aggregateProvisionalScore: number;
}

export interface SystemScoringCompletionEmailDetails {
  challengeId: string;
  challengeName: string;
  submissionId: string;
  memberHandle?: string;
  memberId?: string;
  userId?: string;
  scoringStatus: ScoringCompletionStatus;
  finalSystemScore: number;
  placement: string;
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

interface MemberEmailRecipient {
  email: string;
  handle: string;
}

type ScoringCompletionNotificationType = 'EXAMPLE_PROVISIONAL' | 'SYSTEM';

/**
 * Sends marathon scoring completion emails through Topcoder Bus API after
 * submission or system scoring results are available.
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
   * @param details Submission, challenge, member, status, and provisional score values for the email.
   * @returns Resolves after the email is sent, skipped, or marked failed.
   */
  async sendSubmissionScoringCompleteEmail(
    token: string,
    details: SubmissionScoringCompletionEmailDetails,
  ): Promise<void> {
    const sendgridTemplateId = this.getSubmissionSendgridTemplateId();
    if (!sendgridTemplateId) {
      this.logger.warn(
        'Skipping Marathon Match scoring completion email because SENDGRID_TEMPLATE_ID_SCORING_COMPLETE is not configured.',
      );
      return;
    }

    const reservation = await this.reserveNotification(
      details.challengeId,
      details.submissionId,
      'EXAMPLE_PROVISIONAL',
    );
    if (!reservation) {
      return;
    }

    try {
      const recipient = await this.fetchMemberEmailRecipient(token, details);
      if (!recipient) {
        throw new Error(
          `Member ${this.describeMemberLookup(details)} does not have a handle and email returned by member-api-v6.`,
        );
      }

      await this.postEventBusMessage(
        token,
        this.buildSubmissionEmailPayload(
          details,
          recipient.email,
          recipient.handle,
          sendgridTemplateId,
        ),
      );
      await this.markNotificationSent(
        reservation.id,
        recipient.handle,
        recipient.email,
      );

      this.logger.log({
        message: 'Sent Marathon Match scoring completion email.',
        challengeId: details.challengeId,
        submissionId: details.submissionId,
        memberHandle: recipient.handle,
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
        memberId: details.memberId,
        userId: details.userId,
        error: errorMessage,
      });
    }
  }

  /**
   * Sends the SYSTEM results email if the template is configured and this
   * submission has not already produced a successful SYSTEM notification.
   * @param token M2M token used for member-api-v6 and Bus API calls.
   * @param details Submission, challenge, member, and system score values for the email.
   * @returns Resolves after the email is sent, skipped, or marked failed.
   */
  async sendSystemScoringCompleteEmail(
    token: string,
    details: SystemScoringCompletionEmailDetails,
  ): Promise<void> {
    const sendgridTemplateId = this.getSystemSendgridTemplateId();
    if (!sendgridTemplateId) {
      this.logger.warn(
        'Skipping Marathon Match system scoring email because SENDGRID_TEMPLATE_ID_SYSTEM_TEST_RESULTS is not configured.',
      );
      return;
    }

    const reservation = await this.reserveNotification(
      details.challengeId,
      details.submissionId,
      'SYSTEM',
    );
    if (!reservation) {
      return;
    }

    try {
      const recipient = await this.fetchMemberEmailRecipient(token, details);
      if (!recipient) {
        throw new Error(
          `Member ${this.describeMemberLookup(details)} does not have a handle and email returned by member-api-v6.`,
        );
      }

      await this.postEventBusMessage(
        token,
        this.buildSystemEmailPayload(
          details,
          recipient.email,
          recipient.handle,
          sendgridTemplateId,
        ),
      );
      await this.markNotificationSent(
        reservation.id,
        recipient.handle,
        recipient.email,
      );

      this.logger.log({
        message: 'Sent Marathon Match system scoring email.',
        challengeId: details.challengeId,
        submissionId: details.submissionId,
        memberHandle: recipient.handle,
      });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      await this.markNotificationFailed(reservation.id, errorMessage);
      this.logger.error({
        message: 'Failed to send Marathon Match system scoring email.',
        challengeId: details.challengeId,
        submissionId: details.submissionId,
        memberHandle: details.memberHandle,
        memberId: details.memberId,
        userId: details.userId,
        error: errorMessage,
      });
    }
  }

  /**
   * Reads the SendGrid template ID for example/provisional completion notifications.
   * @returns Configured SendGrid template ID, if present.
   */
  private getSubmissionSendgridTemplateId(): string | undefined {
    return this.asString(process.env.SENDGRID_TEMPLATE_ID_SCORING_COMPLETE);
  }

  /**
   * Reads the SendGrid template ID for SYSTEM result notifications.
   * @returns Configured SendGrid template ID, if present.
   */
  private getSystemSendgridTemplateId(): string | undefined {
    return this.asString(process.env.SENDGRID_TEMPLATE_ID_SYSTEM_TEST_RESULTS);
  }

  /**
   * Reserves the notification row so concurrent scorer callbacks cannot send
   * duplicate completion emails.
   * @param challengeId Challenge identifier.
   * @param submissionId Submission identifier.
   * @param notificationType Distinguishes submission-phase and SYSTEM emails.
   * @returns Reservation row when this worker should send, otherwise undefined.
   */
  private async reserveNotification(
    challengeId: string,
    submissionId: string,
    notificationType: ScoringCompletionNotificationType,
  ): Promise<NotificationReservation | undefined> {
    const rows = await this.prisma.$queryRaw<NotificationReservation[]>(
      Prisma.sql`
        INSERT INTO "marathon_match"."scoringCompletionEmailNotification"
          ("challengeId", "submissionId", "notificationType", "status", "createdAt", "updatedAt")
        VALUES (${challengeId}, ${submissionId}, ${notificationType}, 'PROCESSING', NOW(), NOW())
        ON CONFLICT ("challengeId", "submissionId", "notificationType") DO UPDATE
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
   * Fetches the competitor handle and email from member-api-v6 by handle or user ID.
   * @param token M2M token authorized for member-api-v6.
   * @param details Member identity values from the submission payload.
   * @returns Member handle and email when member-api-v6 returns both values.
   */
  private async fetchMemberEmailRecipient(
    token: string,
    details: Pick<
      SubmissionScoringCompletionEmailDetails,
      'memberHandle' | 'memberId' | 'userId'
    >,
  ): Promise<MemberEmailRecipient | undefined> {
    const memberHandle = this.asString(details.memberHandle);
    const userId = this.coalesceString(
      this.asString(details.userId),
      this.asString(details.memberId),
    );

    if (memberHandle) {
      try {
        const recipient = await this.fetchMemberEmailRecipientByHandle(
          token,
          memberHandle,
        );
        if (recipient) {
          return recipient;
        }
      } catch (error) {
        if (!userId) {
          throw error;
        }

        this.logger.warn({
          message:
            'Member handle lookup failed while resolving scoring completion email recipient; falling back to userId lookup.',
          memberHandle,
          userId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (userId) {
      return this.fetchMemberEmailRecipientByUserId(token, userId);
    }

    return undefined;
  }

  /**
   * Fetches the competitor handle and email from member-api-v6 by handle.
   * @param token M2M token authorized for member-api-v6.
   * @param memberHandle Member handle to look up.
   * @returns Member handle and email when member-api-v6 returns both values.
   */
  private async fetchMemberEmailRecipientByHandle(
    token: string,
    memberHandle: string,
  ): Promise<MemberEmailRecipient | undefined> {
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

    return this.toMemberEmailRecipient(
      this.extractMemberRecord(response.data),
      memberHandle,
    );
  }

  /**
   * Fetches the competitor handle and email from member-api-v6 by user ID.
   * @param token M2M token authorized for member-api-v6.
   * @param userId Topcoder user ID to look up.
   * @returns Member handle and email when member-api-v6 returns both values.
   */
  private async fetchMemberEmailRecipientByUserId(
    token: string,
    userId: string,
  ): Promise<MemberEmailRecipient | undefined> {
    const response = await firstValueFrom(
      this.httpService.get(this.buildMembersUrl(), {
        headers: {
          Authorization: `Bearer ${token}`,
        },
        params: {
          fields: 'handle,email',
          userId,
        },
      }),
    );

    return this.toMemberEmailRecipient(this.extractMemberRecord(response.data));
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
   * @param details Submission, challenge, member, status, and provisional score values.
   * @param recipientEmail Email address to receive the notification.
   * @param memberHandle Resolved member handle for template data.
   * @param sendgridTemplateId SendGrid dynamic template ID.
   * @returns Event bus email payload.
   */
  private buildSubmissionEmailPayload(
    details: SubmissionScoringCompletionEmailDetails,
    recipientEmail: string,
    memberHandle: string,
    sendgridTemplateId: string,
  ): EventBusEmailPayload {
    const challengeUrl = this.buildChallengeUrl(details.challengeId);
    const fromEmail = this.getEmailFromAddress();

    return {
      from: fromEmail,
      replyTo: fromEmail,
      recipients: [recipientEmail],
      data: {
        memberHandle,
        submissionId: details.submissionId,
        challengeName: details.challengeName,
        challengeId: details.challengeId,
        challengeUrl,
        challengeURL: challengeUrl,
        scoringStatus: details.scoringStatus,
        aggregateProvisionalScore: details.aggregateProvisionalScore,
      },
      sendgrid_template_id: sendgridTemplateId,
      version: 'v3',
    };
  }

  /**
   * Builds the SYSTEM result email payload expected by the `external.action.email` topic.
   * @param details Submission, challenge, member, and system score values.
   * @param recipientEmail Email address to receive the notification.
   * @param memberHandle Resolved member handle for template data.
   * @param sendgridTemplateId SendGrid dynamic template ID.
   * @returns Event bus email payload.
   */
  private buildSystemEmailPayload(
    details: SystemScoringCompletionEmailDetails,
    recipientEmail: string,
    memberHandle: string,
    sendgridTemplateId: string,
  ): EventBusEmailPayload {
    const challengeUrl = this.buildChallengeUrl(details.challengeId);
    const fromEmail = this.getEmailFromAddress();

    return {
      from: fromEmail,
      replyTo: fromEmail,
      recipients: [recipientEmail],
      data: {
        memberHandle,
        submissionId: details.submissionId,
        challengeName: details.challengeName,
        challengeId: details.challengeId,
        challengeUrl,
        challengeURL: challengeUrl,
        scoringStatus: details.scoringStatus,
        finalSystemScore: details.finalSystemScore,
        placement: details.placement,
      },
      sendgrid_template_id: sendgridTemplateId,
      version: 'v3',
    };
  }

  /**
   * Builds the public challenge URL included in email template data.
   * Numeric legacy Marathon Match round IDs are not valid challenge-api GUIDs,
   * so they link to legacy longcontest standings instead of the v6 challenge UI.
   * @param challengeId Challenge identifier or legacy Marathon Match round ID.
   * @returns Public Topcoder challenge or legacy Marathon Match standings URL.
   */
  private buildChallengeUrl(challengeId: string): string {
    if (/^\d+$/.test(challengeId.trim())) {
      return `https://community.topcoder.com/longcontest/?module=ViewStandings&rd=${encodeURIComponent(challengeId.trim())}`;
    }

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
    return `${this.buildMemberApiBaseUrl()}/members/${encodeURIComponent(memberHandle)}`;
  }

  /**
   * Builds the member-api-v6 members search URL.
   * @returns Absolute member API members URL.
   */
  private buildMembersUrl(): string {
    return `${this.buildMemberApiBaseUrl()}/members`;
  }

  /**
   * Builds the member-api-v6 base URL from environment configuration.
   * @returns Absolute member API v6 base URL.
   */
  private buildMemberApiBaseUrl(): string {
    const rawBase = (
      process.env.MEMBER_API_URL || 'https://api.topcoder-dev.com/v6'
    )
      .replace(/\/+$/, '')
      .replace(/\/members$/, '');
    return rawBase.endsWith('/v6') ? rawBase : `${rawBase}/v6`;
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
    const records = this.extractMemberRecords(data);
    return records[0] ?? {};
  }

  /**
   * Extracts member objects from direct, array, and wrapped member-api-v6 responses.
   * @param data Raw response body from member-api-v6.
   * @returns Member records found in the response.
   */
  private extractMemberRecords(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((entry) => this.asRecord(entry));
    }

    const direct = this.asRecord(data);
    if (Object.keys(direct).length === 0) {
      return [];
    }

    if (Array.isArray(direct.content)) {
      return direct.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(direct.data)) {
      return direct.data.map((entry) => this.asRecord(entry));
    }

    const result = this.asRecord(direct.result);
    if (Array.isArray(result.content)) {
      return result.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(result.data)) {
      return result.data.map((entry) => this.asRecord(entry));
    }

    if (Object.keys(result).length > 0) {
      return [result];
    }

    const dataRecord = this.asRecord(direct.data);
    if (Object.keys(dataRecord).length > 0) {
      return [dataRecord];
    }

    return [direct];
  }

  /**
   * Converts a member-api-v6 record into the recipient shape required for email.
   * @param memberRecord Member record returned by member-api-v6.
   * @param fallbackHandle Handle from the submission payload, if available.
   * @returns Recipient details when both handle and email are available.
   */
  private toMemberEmailRecipient(
    memberRecord: Record<string, unknown>,
    fallbackHandle?: string,
  ): MemberEmailRecipient | undefined {
    const email = this.asString(memberRecord.email);
    const handle =
      this.asString(memberRecord.handle) ?? this.asString(fallbackHandle);

    if (!email || !handle) {
      return undefined;
    }

    return {
      email,
      handle,
    };
  }

  /**
   * Formats a member lookup description for diagnostic errors.
   * @param details Member identity values from the submission payload.
   * @returns Human-readable lookup description.
   */
  private describeMemberLookup(
    details: Pick<
      SubmissionScoringCompletionEmailDetails,
      'memberHandle' | 'memberId' | 'userId'
    >,
  ): string {
    return (
      this.coalesceString(
        this.asString(details.memberHandle),
        this.asString(details.userId),
        this.asString(details.memberId),
      ) ?? 'unknown'
    );
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

  /**
   * Returns the first non-empty string from the provided values.
   * @param values Candidate string values.
   * @returns First non-empty value, otherwise undefined.
   */
  private coalesceString(
    ...values: Array<string | undefined>
  ): string | undefined {
    return values.find((value) => value !== undefined && value.trim() !== '');
  }
}
