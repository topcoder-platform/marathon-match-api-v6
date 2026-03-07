import { HttpService } from '@nestjs/axios';
import { Injectable } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { M2MService } from 'src/shared/modules/global/m2m.service';

export interface ScoringResultCallbackPayload {
  submissionId: string;
  score: number;
  testPhase: string;
  reviewTypeId: string;
  scorecardId?: string;
  metadata?: Record<string, unknown>;
  currentReview?: Record<string, unknown>;
  impactedReviews?: Record<string, unknown>[];
}

interface ReviewSummationPayload {
  submissionId: string;
  aggregateScore: number;
  isPassing: boolean;
  reviewedDate: string;
  scorecardId?: string;
  isFinal?: boolean;
  isProvisional?: boolean;
  isExample?: boolean;
  metadata?: Record<string, unknown>;
}

interface SummationBuildInput {
  submissionId: string;
  score: number;
  scorecardId?: string;
  metadata?: Record<string, unknown>;
  reviewObject?: Record<string, unknown>;
  testPhase: string;
}

/**
 * Applies marathon-match review summation updates based on scorer callback data.
 * Relative-score propagation is handled here to keep ECS runner logic lightweight.
 */
@Injectable()
export class ScoringResultService {
  private readonly logger = LoggerService.forRoot('ScoringResultService');

  constructor(
    private readonly httpService: HttpService,
    private readonly m2mService: M2MService,
  ) {}

  /**
   * Processes one scorer callback payload and upserts all required review summations.
   */
  async processScoringResult(
    payload: ScoringResultCallbackPayload,
  ): Promise<void> {
    const normalizedPhase = this.normalizeTestPhase(payload.testPhase);
    const token = await this.m2mService.getM2MToken();

    if (!token) {
      throw new Error('Unable to get M2M token for review summation upsert.');
    }

    const fallbackMetadata = this.normalizeMetadata(
      payload.metadata,
      normalizedPhase,
      payload.reviewTypeId,
    );

    if (
      payload.currentReview &&
      Object.keys(payload.currentReview).length > 0
    ) {
      await this.upsertFromLegacyReviewPayload(token, {
        legacyReview: payload.currentReview,
        fallbackSubmissionId: payload.submissionId,
        fallbackScore: payload.score,
        fallbackScorecardId: payload.scorecardId,
        fallbackMetadata,
        testPhase: normalizedPhase,
      });

      for (const impactedReview of payload.impactedReviews ?? []) {
        await this.upsertFromLegacyReviewPayload(token, {
          legacyReview: impactedReview,
          fallbackSubmissionId: payload.submissionId,
          fallbackScore: payload.score,
          fallbackScorecardId: payload.scorecardId,
          fallbackMetadata,
          testPhase: normalizedPhase,
        });
      }

      return;
    }

    const reviewPayload = this.buildSummationPayload({
      submissionId: payload.submissionId,
      score: payload.score,
      scorecardId: payload.scorecardId,
      metadata: fallbackMetadata,
      testPhase: normalizedPhase,
    });

    await this.createReviewSummation(token, reviewPayload);
  }

  private async upsertFromLegacyReviewPayload(
    token: string,
    args: {
      legacyReview: Record<string, unknown>;
      fallbackSubmissionId: string;
      fallbackScore: number;
      fallbackScorecardId?: string;
      fallbackMetadata: Record<string, unknown>;
      testPhase: string;
    },
  ): Promise<void> {
    const reviewObject = this.asRecord(args.legacyReview);

    const submissionId = this.coalesceString(
      this.asString(reviewObject.submissionId),
      args.fallbackSubmissionId,
    );

    if (!submissionId) {
      throw new Error('Legacy review payload is missing submissionId.');
    }

    const scorecardId = this.coalesceString(
      this.asString(reviewObject.scorecardId),
      this.asString(reviewObject.scoreCardId),
      args.fallbackScorecardId,
    );

    const metadata = this.normalizeMetadata(
      this.asRecord(reviewObject.metadata),
      args.testPhase,
      this.asString(args.fallbackMetadata.reviewTypeId),
      args.fallbackMetadata,
    );

    const score = this.resolveReviewScore(
      reviewObject,
      args.testPhase,
      args.fallbackScore,
    );

    const reviewPayload = this.buildSummationPayload({
      submissionId,
      score,
      scorecardId,
      metadata,
      reviewObject,
      testPhase: args.testPhase,
    });

    const reviewId = this.asString(reviewObject.id);
    if (reviewId) {
      await this.updateReviewSummation(token, reviewId, reviewPayload);
      return;
    }

    await this.createReviewSummation(token, reviewPayload);
  }

  private buildSummationPayload(
    input: SummationBuildInput,
  ): ReviewSummationPayload {
    const metadata = this.asRecord(input.metadata);

    const normalizedTestType = this.normalizeTestPhase(
      this.coalesceString(this.asString(metadata.testType), input.testPhase),
    );
    const normalizedStage = this.asString(metadata.stage)?.toLowerCase();

    const metaIsFinal = this.parseBooleanFlag(metadata.isFinal);
    const reviewIsFinal = this.parseBooleanFlag(input.reviewObject?.isFinal);
    const metaIsProvisional = this.parseBooleanFlag(metadata.isProvisional);
    const metaIsExample = this.parseBooleanFlag(metadata.isExample);

    const shouldSetFinal =
      metaIsFinal === true ||
      reviewIsFinal === true ||
      normalizedTestType === 'system' ||
      normalizedStage === 'final';

    const shouldSetProvisional =
      !shouldSetFinal &&
      (normalizedTestType === 'provisional' || metaIsProvisional === true);

    const shouldSetExample =
      normalizedTestType === 'example' || metaIsExample === true;

    const payload: ReviewSummationPayload = {
      submissionId: input.submissionId,
      aggregateScore: input.score,
      isPassing: input.score >= 0,
      reviewedDate: new Date().toISOString(),
      ...(input.scorecardId ? { scorecardId: input.scorecardId } : {}),
      ...(shouldSetFinal ? { isFinal: true } : {}),
      ...(shouldSetProvisional ? { isProvisional: true } : {}),
      ...(shouldSetExample ? { isExample: true } : {}),
      ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
    };

    return payload;
  }

  private resolveReviewScore(
    reviewObject: Record<string, unknown>,
    testPhase: string,
    fallbackScore: number,
  ): number {
    const systemPhase = this.normalizeTestPhase(testPhase) === 'system';

    const preferredScore = this.toNumber(
      reviewObject[systemPhase ? 'aggregateScore' : 'score'],
    );
    if (preferredScore !== null) {
      return preferredScore;
    }

    const alternateScore = this.toNumber(
      reviewObject[systemPhase ? 'score' : 'aggregateScore'],
    );
    if (alternateScore !== null) {
      return alternateScore;
    }

    return fallbackScore;
  }

  private normalizeMetadata(
    metadata: Record<string, unknown> | undefined,
    testPhase: string,
    reviewTypeId?: string,
    fallbackMetadata?: Record<string, unknown>,
  ): Record<string, unknown> {
    const normalized: Record<string, unknown> = {
      ...(fallbackMetadata ?? {}),
      ...(metadata ?? {}),
      testType: this.normalizeTestPhase(testPhase),
    };

    if (reviewTypeId) {
      normalized.reviewTypeId = reviewTypeId;
    }

    return normalized;
  }

  private async createReviewSummation(
    token: string,
    payload: ReviewSummationPayload,
  ): Promise<void> {
    const url = this.buildReviewSummationUrl();

    try {
      await firstValueFrom(
        this.httpService.post(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Failed to create review summation',
        url,
        payload,
        error: message,
      });
      throw new Error(`Failed to create review summation: ${message}`);
    }
  }

  private async updateReviewSummation(
    token: string,
    reviewSummationId: string,
    payload: ReviewSummationPayload,
  ): Promise<void> {
    const url = `${this.buildReviewSummationUrl()}/${reviewSummationId}`;

    try {
      await firstValueFrom(
        this.httpService.put(url, payload, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({
        message: 'Failed to update review summation',
        url,
        payload,
        error: message,
      });
      throw new Error(`Failed to update review summation: ${message}`);
    }
  }

  private buildReviewSummationUrl(): string {
    const baseUrl = (
      process.env.REVIEW_API_URL || 'https://api.topcoder-dev.com'
    ).replace(/\/+$/, '');

    if (baseUrl.endsWith('/reviewSummations')) {
      return baseUrl;
    }

    if (baseUrl.endsWith('/v6')) {
      return `${baseUrl}/reviewSummations`;
    }

    return `${baseUrl}/v6/reviewSummations`;
  }

  private normalizeTestPhase(testPhase: string | undefined): string {
    const normalized = (testPhase || '').trim().toLowerCase();

    if (normalized === 'example') {
      return 'example';
    }
    if (normalized === 'system' || normalized === 'final') {
      return 'system';
    }

    return 'provisional';
  }

  private parseBooleanFlag(value: unknown): boolean | null {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') {
        return true;
      }
      if (normalized === 'false') {
        return false;
      }
    }

    return null;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return {};
    }

    return { ...(value as Record<string, unknown>) };
  }

  private asString(value: unknown): string | undefined {
    if (value === null || value === undefined) {
      return undefined;
    }

    if (typeof value !== 'string' && typeof value !== 'number') {
      return undefined;
    }

    const asString = `${value}`.trim();
    return asString.length > 0 ? asString : undefined;
  }

  private toNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value.trim());
      return Number.isFinite(parsed) ? parsed : null;
    }

    return null;
  }

  private coalesceString(
    ...values: Array<string | undefined>
  ): string | undefined {
    for (const value of values) {
      if (value && value.trim().length > 0) {
        return value;
      }
    }

    return undefined;
  }
}
