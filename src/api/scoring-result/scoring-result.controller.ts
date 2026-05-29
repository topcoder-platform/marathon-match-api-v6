import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { Scopes } from 'src/shared/decorators/scopes.decorator';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import {
  ScoringProgressCallbackPayload,
  ScoringResultCallbackPayload,
  ScoringResultService,
  ScoringTestStatus,
} from './scoring-result.service';

/**
 * Request payload sent by the ECS scorer callback when a review score is ready.
 */
class ScoringResultCallbackDto implements ScoringResultCallbackPayload {
  @ApiProperty({
    description: 'Challenge ID that owns the scored submission',
    example: '30000123',
  })
  @IsString()
  challengeId: string;

  @ApiProperty({
    description: 'Submission ID produced by the submission API',
    example: '3f1f8b69-4ea0-4453-a293-60f52e69f25d',
  })
  @IsString()
  submissionId: string;

  @ApiProperty({
    description: 'Score returned by the scorer for this callback',
    example: 97.25,
  })
  @Type(() => Number)
  @IsNumber()
  score: number;

  @ApiProperty({
    description: 'Raw scorer phase value used to derive the review test type',
    example: 'test',
  })
  @IsString()
  testPhase: string;

  @ApiProperty({
    description: 'Review type ID that should be written into review metadata',
    example: 'cfca92f1-4f76-4c27-8fc4-4db60ff6e778',
  })
  @IsString()
  reviewTypeId: string;

  @ApiPropertyOptional({
    description: 'Review ID to complete after summation upsert succeeds',
    example: '7af90e06-d65a-4c0f-acaf-61d4f0c71234',
  })
  @IsOptional()
  @IsString()
  reviewId?: string;

  @ApiPropertyOptional({
    description: 'Scorecard ID to attach to the review summation',
    example: '31d0ad44-2d47-43d7-b1c7-436f26d4673d',
  })
  @IsOptional()
  @IsString()
  scorecardId?: string;

  @ApiPropertyOptional({
    description: 'Additional scorer metadata forwarded to the review summation',
    type: 'object',
    additionalProperties: true,
    example: {
      reviewTypeId: 'cfca92f1-4f76-4c27-8fc4-4db60ff6e778',
      testProcess: 'provisional',
      testType: 'provisional',
    },
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Legacy current review payload used when the callback includes a fully materialized review object',
    type: 'object',
    additionalProperties: true,
    example: {
      submissionId: '3f1f8b69-4ea0-4453-a293-60f52e69f25d',
      score: 97.25,
    },
  })
  @IsOptional()
  @IsObject()
  currentReview?: Record<string, unknown>;

  @ApiPropertyOptional({
    description:
      'Legacy impacted review payloads that should also be upserted by the callback handler',
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: true,
    },
    example: [
      {
        submissionId: '3f1f8b69-4ea0-4453-a293-60f52e69f25d',
        score: 96.5,
      },
    ],
  })
  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  impactedReviews?: Record<string, unknown>[];
}

/**
 * Request payload sent by the ECS runner while provisional/system tests are running.
 */
class ScoringProgressCallbackDto implements ScoringProgressCallbackPayload {
  @ApiProperty({
    description: 'Challenge ID that owns the scored submission',
    example: '30000123',
  })
  @IsString()
  challengeId: string;

  @ApiProperty({
    description: 'Submission ID produced by the submission API',
    example: '3f1f8b69-4ea0-4453-a293-60f52e69f25d',
  })
  @IsString()
  submissionId: string;

  @ApiProperty({
    description: 'Raw scorer phase value used to derive the review test type',
    example: 'provisional',
  })
  @IsString()
  testPhase: string;

  @ApiProperty({
    description: 'Review type ID that should be written into review metadata',
    example: 'cfca92f1-4f76-4c27-8fc4-4db60ff6e778',
  })
  @IsString()
  reviewTypeId: string;

  @ApiProperty({
    description: 'Test execution progress from 0 (none run) to 1 (all run)',
    minimum: 0,
    maximum: 1,
    example: 0.45,
  })
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(1)
  progress: number;

  @ApiProperty({
    description: 'Current test execution status',
    enum: ScoringTestStatus,
    example: ScoringTestStatus.InProgress,
  })
  @IsIn(Object.values(ScoringTestStatus))
  status: ScoringTestStatus;

  @ApiPropertyOptional({
    description: 'Review ID associated with a system-review scoring task',
    example: '7af90e06-d65a-4c0f-acaf-61d4f0c71234',
  })
  @IsOptional()
  @IsString()
  reviewId?: string;

  @ApiPropertyOptional({
    description: 'Scorecard ID to attach to the review summation',
    example: '31d0ad44-2d47-43d7-b1c7-436f26d4673d',
  })
  @IsOptional()
  @IsString()
  scorecardId?: string;

  @ApiPropertyOptional({
    description: 'Number of tests completed so far',
    example: 9,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  completedTests?: number;

  @ApiPropertyOptional({
    description: 'Total number of tests in the phase',
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  totalTests?: number;

  @ApiPropertyOptional({
    description: 'Number of tests with runner-reported errors so far',
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  failedTests?: number;

  @ApiPropertyOptional({
    description: 'Short runner progress or failure message',
    example: 'Completed test 9 of 20',
  })
  @IsOptional()
  @IsString()
  message?: string;

  @ApiPropertyOptional({
    description: 'Additional metadata forwarded to the review summation',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}

class TriggerSystemScoreDto {
  @ApiProperty({
    description: 'Review ID created in review-api for the system reviewer',
    example: '7af90e06-d65a-4c0f-acaf-61d4f0c71234',
  })
  @IsString()
  @IsNotEmpty()
  reviewId: string;

  @ApiProperty({
    description: 'Submission ID to score',
    example: '3f1f8b69-4ea0-4453-a293-60f52e69f25d',
  })
  @IsString()
  @IsNotEmpty()
  submissionId: string;

  @ApiProperty({
    description: 'Challenge ID that owns the submission',
    example: '30000123',
  })
  @IsString()
  @IsNotEmpty()
  challengeId: string;
}

/**
 * Receives scorer callback payloads from ECS runner and applies review updates.
 */
@ApiTags('Scoring Result')
@ApiBearerAuth()
@Controller('/internal')
export class ScoringResultController {
  constructor(private readonly scoringResultService: ScoringResultService) {}

  /**
   * Ingests scorer output for a configured challenge and performs review summation upserts.
   */
  @Post('/scoring-results')
  @Roles(UserRole.Admin)
  @Scopes(Scope.UpdateMarathonMatch)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest scorer callback and upsert review summations',
    description:
      'Roles: Admin | Scopes: update:marathon-match. Intended for ECS runner callback use.',
  })
  @ApiBody({ type: ScoringResultCallbackDto })
  @ApiResponse({
    status: 202,
    description: 'Scoring callback accepted and processed.',
  })
  @ApiResponse({
    status: 400,
    description:
      'Invalid callback payload or unknown submissionId rejected by review-api.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Marathon Match config not found for the provided challengeId.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async ingestScoringResult(
    @Body() payload: ScoringResultCallbackDto,
  ): Promise<{ status: string }> {
    await this.scoringResultService.processScoringResult(payload);
    return { status: 'accepted' };
  }

  /**
   * Ingests runner progress while provisional/system scoring is still running.
   */
  @Post('/scoring-progress')
  @Roles(UserRole.Admin)
  @Scopes(Scope.UpdateMarathonMatch)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Ingest Marathon Match scoring progress',
    description:
      'Roles: Admin | Scopes: update:marathon-match. Intended for ECS runner progress updates before final scoring callback.',
  })
  @ApiBody({ type: ScoringProgressCallbackDto })
  @ApiResponse({
    status: 202,
    description: 'Scoring progress accepted and persisted.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid progress payload or unknown submissionId.',
  })
  @ApiResponse({
    status: 404,
    description:
      'Marathon Match config not found for the provided challengeId.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async ingestScoringProgress(
    @Body() payload: ScoringProgressCallbackDto,
  ): Promise<{ status: string }> {
    await this.scoringResultService.processScoringProgress(payload);
    return { status: 'accepted' };
  }

  /**
   * Dispatches the SYSTEM scorer task for a Marathon Match review.
   */
  @Post('/system-score')
  @Roles(UserRole.Admin)
  @Scopes(Scope.UpdateMarathonMatch)
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({
    summary: 'Dispatch Marathon Match SYSTEM scoring for a pending review',
    description:
      'Roles: Admin | Scopes: update:marathon-match. Intended for autopilot review orchestration.',
  })
  @ApiBody({ type: TriggerSystemScoreDto })
  @ApiResponse({
    status: 202,
    description: 'SYSTEM scoring dispatch accepted.',
  })
  @ApiResponse({ status: 400, description: 'Invalid system scoring payload.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async triggerSystemScore(
    @Body() payload: TriggerSystemScoreDto,
  ): Promise<{ status: string }> {
    await this.scoringResultService.triggerSystemScore(
      payload.reviewId,
      payload.submissionId,
      payload.challengeId,
    );
    return { status: 'accepted' };
  }
}
