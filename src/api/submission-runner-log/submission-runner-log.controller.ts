import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  RunnerLogAccessRequest,
  SubmissionRunnerLogAccessGuard,
} from 'src/shared/guards/submission-runner-log-access.guard';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { Scopes } from 'src/shared/decorators/scopes.decorator';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import {
  GetSubmissionRunnerLogsOptions,
  SubmissionRunnerLogService,
  SubmissionRunnerLogsResponse,
} from './submission-runner-log.service';

class SubmissionRunnerLogsQueryDto {
  @IsOptional()
  @IsString()
  taskArn?: string;

  @IsOptional()
  @IsString()
  nextToken?: string;

  @IsOptional()
  @IsString()
  startFromHead?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10000)
  limit?: number;
}

/**
 * Exposes API endpoints for reading persisted ECS runner log mappings and
 * CloudWatch log output by submission ID.
 */
@ApiTags('Submission Runner Logs')
@ApiBearerAuth()
@Controller('/submissions')
export class SubmissionRunnerLogController {
  constructor(
    private readonly submissionRunnerLogService: SubmissionRunnerLogService,
  ) {}

  /**
   * Retrieves ECS runner logs for a submission ID.
   * @param submissionId Submission ID.
   * @param query Optional task selection + CloudWatch pagination query.
   * @param request Request carrying the challenge scope resolved by `SubmissionRunnerLogAccessGuard`.
   * @returns Mapping metadata and CloudWatch log events.
   */
  @Get('/:submissionId/runner-logs')
  @Roles(UserRole.Admin, UserRole.Copilot, UserRole.ProjectManager)
  @Scopes(Scope.ReadMarathonMatch)
  @UseGuards(SubmissionRunnerLogAccessGuard)
  @ApiOperation({
    summary: 'Get ECS runner logs for a submission',
    description:
      'Roles: Admin, challenge-assigned Copilot/Manager | Scopes: read:marathon-match. Uses persisted submission-to-task/log mapping rows and fetches CloudWatch events.',
  })
  @ApiParam({
    name: 'submissionId',
    description: 'Submission ID whose ECS runner logs should be retrieved',
    example: '11111111-2222-3333-4444-555555555555',
  })
  @ApiQuery({
    name: 'taskArn',
    required: false,
    description:
      'Optional specific ECS task ARN when multiple runner launches exist for the submission',
  })
  @ApiQuery({
    name: 'nextToken',
    required: false,
    description: 'Optional CloudWatch pagination token',
  })
  @ApiQuery({
    name: 'startFromHead',
    required: false,
    description:
      'Optional boolean string (`true`/`false`) controlling CloudWatch pagination direction',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Optional CloudWatch page size (1-10000)',
    type: Number,
    example: 200,
  })
  @ApiResponse({
    status: 200,
    description: 'Runner mapping details and CloudWatch log events.',
  })
  @ApiResponse({
    status: 400,
    description: 'Invalid query parameter format.',
  })
  @ApiResponse({
    status: 403,
    description: 'Forbidden.',
  })
  @ApiResponse({
    status: 404,
    description: 'No runner log mapping found for the given submission.',
  })
  async getRunnerLogs(
    @Param('submissionId') submissionId: string,
    @Query() query: SubmissionRunnerLogsQueryDto,
    @Req() request: RunnerLogAccessRequest,
  ): Promise<SubmissionRunnerLogsResponse> {
    const options: GetSubmissionRunnerLogsOptions = {
      taskArn: query.taskArn,
      nextToken: query.nextToken,
      startFromHead: this.parseOptionalBoolean(query.startFromHead),
      limit: query.limit,
      authorizedChallengeId: request.runnerLogAccess?.challengeId,
    };

    return this.submissionRunnerLogService.getLogsForSubmission(
      submissionId,
      options,
    );
  }

  /**
   * Parses optional boolean query string values.
   * @param value Raw query value.
   * @returns Parsed boolean or undefined when no value is provided.
   * @throws BadRequestException when value is not `true` or `false`.
   */
  private parseOptionalBoolean(value?: string): boolean | undefined {
    if (value === undefined || value === null || value.trim() === '') {
      return undefined;
    }

    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') {
      return true;
    }
    if (normalized === 'false') {
      return false;
    }

    throw new BadRequestException(
      'Invalid startFromHead value. Use true or false.',
    );
  }
}
