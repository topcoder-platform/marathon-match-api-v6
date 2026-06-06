import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
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
import { User } from 'src/shared/decorators/user.decorator';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
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
   * @param user Authenticated caller used for submission ownership checks.
   * @returns Mapping metadata and CloudWatch log events.
   */
  @Get('/:submissionId/runner-logs')
  @Roles(
    UserRole.Admin,
    UserRole.Copilot,
    UserRole.ProjectManager,
    UserRole.User,
  )
  @ApiOperation({
    summary: 'Get ECS runner logs for a submission',
    description:
      'Roles: Admin, Copilot, Manager, or submission owner. Uses persisted submission-to-task/log mapping rows and fetches CloudWatch events.',
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
    @User() user: JwtUser,
  ): Promise<SubmissionRunnerLogsResponse> {
    const options: GetSubmissionRunnerLogsOptions = {
      taskArn: query.taskArn,
      nextToken: query.nextToken,
      startFromHead: this.parseOptionalBoolean(query.startFromHead),
      limit: query.limit,
    };

    return this.submissionRunnerLogService.getLogsForSubmission(
      submissionId,
      options,
      user,
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
