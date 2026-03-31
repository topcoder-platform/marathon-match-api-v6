import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiProperty,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
} from 'class-validator';
import { Scopes } from 'src/shared/decorators/scopes.decorator';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import {
  ScoringResultCallbackPayload,
  ScoringResultService,
} from './scoring-result.service';

class ScoringResultCallbackDto implements ScoringResultCallbackPayload {
  @IsString()
  challengeId: string;

  @IsString()
  submissionId: string;

  @Type(() => Number)
  @IsNumber()
  score: number;

  @IsString()
  testPhase: string;

  @IsString()
  reviewTypeId: string;

  @IsOptional()
  @IsString()
  reviewId?: string;

  @IsOptional()
  @IsString()
  scorecardId?: string;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;

  @IsOptional()
  @IsObject()
  currentReview?: Record<string, unknown>;

  @IsOptional()
  @IsArray()
  @IsObject({ each: true })
  impactedReviews?: Record<string, unknown>[];
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
  @ApiResponse({ status: 400, description: 'Invalid callback payload.' })
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
