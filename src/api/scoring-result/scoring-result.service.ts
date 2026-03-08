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
  private readonly scorecardIdLookupCache = new Map<string, string | null>();

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
    const fallbackScorecardId = await this.resolveScorecardId(
      token,
      payload.scorecardId,
    );

    if (
      payload.currentReview &&
      Object.keys(payload.currentReview).length > 0
    ) {
      await this.upsertFromLegacyReviewPayload(token, {
        legacyReview: payload.currentReview,
        fallbackSubmissionId: payload.submissionId,
        fallbackScore: payload.score,
        fallbackScorecardId,
        fallbackMetadata,
        testPhase: normalizedPhase,
      });

      for (const impactedReview of payload.impactedReviews ?? []) {
        await this.upsertFromLegacyReviewPayload(token, {
          legacyReview: impactedReview,
          fallbackSubmissionId: payload.submissionId,
          fallbackScore: payload.score,
          fallbackScorecardId,
          fallbackMetadata,
          testPhase: normalizedPhase,
        });
      }

      return;
    }

    const reviewPayload = this.buildSummationPayload({
      submissionId: payload.submissionId,
      score: payload.score,
      scorecardId: fallbackScorecardId,
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

    const rawScorecardId = this.coalesceString(
      this.asString(reviewObject.scorecardId),
      this.asString(reviewObject.scoreCardId),
      args.fallbackScorecardId,
    );
    const scorecardId = await this.resolveScorecardId(token, rawScorecardId);

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
      const errorDetails = this.extractHttpError(error);
      this.logger.error({
        message: 'Failed to create review summation',
        url,
        payload,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      throw new Error(
        `Failed to create review summation: ${errorDetails.message}`,
      );
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
      const errorDetails = this.extractHttpError(error);
      this.logger.error({
        message: 'Failed to update review summation',
        url,
        payload,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      throw new Error(
        `Failed to update review summation: ${errorDetails.message}`,
      );
    }
  }

  /**
   * Resolves scorecard references to canonical review-api ids.
   * The input can be either the internal id or legacy id.
   */
  private async resolveScorecardId(
    token: string,
    scorecardId?: string,
  ): Promise<string | undefined> {
    const rawScorecardId = this.asString(scorecardId);
    if (!rawScorecardId) {
      return undefined;
    }

    const cached = this.scorecardIdLookupCache.get(rawScorecardId);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    const url = this.buildScorecardLookupUrl(rawScorecardId);
    try {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      const resolvedScorecardId = this.asString(
        this.asRecord(response.data).id,
      );
      if (!resolvedScorecardId) {
        this.logger.warn({
          message: 'Scorecard lookup response did not include an id',
          requestedScorecardId: rawScorecardId,
          url,
        });
        return undefined;
      }

      this.scorecardIdLookupCache.set(rawScorecardId, resolvedScorecardId);
      return resolvedScorecardId;
    } catch (error) {
      const errorDetails = this.extractHttpError(error);
      this.logger.warn({
        message:
          'Unable to resolve scorecardId from review-api. scorecardId will be omitted from review summation payload.',
        requestedScorecardId: rawScorecardId,
        url,
        statusCode: errorDetails.statusCode ?? null,
        responseBody: errorDetails.responseBody ?? null,
        error: errorDetails.message,
      });
      if (errorDetails.statusCode === 400 || errorDetails.statusCode === 404) {
        this.scorecardIdLookupCache.set(rawScorecardId, null);
      }
      return undefined;
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

  private buildScorecardLookupUrl(scorecardId: string): string {
    const reviewApiBaseUrl = this.buildReviewSummationUrl().replace(
      /\/reviewSummations$/,
      '',
    );

    return `${reviewApiBaseUrl}/scorecards/${encodeURIComponent(scorecardId)}`;
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

  private extractHttpError(error: unknown): {
    message: string;
    statusCode?: number;
    responseBody?: unknown;
  } {
    const fallbackMessage =
      error instanceof Error ? error.message : String(error);

    if (!error || typeof error !== 'object') {
      return { message: fallbackMessage };
    }

    const response = (
      error as {
        response?: {
          status?: unknown;
          data?: unknown;
        };
      }
    ).response;

    const statusCode =
      typeof response?.status === 'number' ? response.status : undefined;
    const responseBody = response?.data;

    const responseMessage = this.asString(this.asRecord(responseBody).message);
    const message =
      statusCode !== undefined
        ? responseMessage
          ? `HTTP ${statusCode}: ${responseMessage}`
          : `HTTP ${statusCode}`
        : fallbackMessage;

    return {
      message,
      statusCode,
      responseBody,
    };
  }
}
