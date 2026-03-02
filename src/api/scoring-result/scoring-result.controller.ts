import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
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

/**
 * Receives scorer callback payloads from ECS runner and applies review updates.
 */
@ApiTags('Scoring Result')
@ApiBearerAuth()
@Controller('/internal')
export class ScoringResultController {
  constructor(private readonly scoringResultService: ScoringResultService) {}

  /**
   * Ingests scorer output and performs review summation upserts.
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
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async ingestScoringResult(
    @Body() payload: ScoringResultCallbackDto,
  ): Promise<{ status: string }> {
    await this.scoringResultService.processScoringResult(payload);
    return { status: 'accepted' };
  }
}
