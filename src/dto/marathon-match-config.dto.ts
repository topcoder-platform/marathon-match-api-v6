import { ApiProperty } from '@nestjs/swagger';
import { PhaseConfigType, ScoreDirection } from '@prisma/client';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Min,
  registerDecorator,
  ValidateNested,
  ValidationOptions,
} from 'class-validator';

const MAX_START_SEED = BigInt('9223372036854775807');
const START_SEED_PATTERN = /^(0|[1-9]\d*)$/;

/**
 * Converts supported start seed inputs into a trimmed decimal string for validation.
 * @param value Raw request value from JSON or a programmatic service call.
 * @returns Decimal string for safe inputs, or the original value when it should fail validation.
 */
function transformStartSeed(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? String(value) : value;
  }

  if (typeof value === 'string') {
    return value.trim();
  }

  return value;
}

/**
 * Checks whether a value is a non-negative PostgreSQL BIGINT and Java long seed.
 * @param value Candidate transformed start seed.
 * @returns True when the value is a decimal integer string in the supported range.
 */
function isStartSeed(value: unknown): value is string {
  if (typeof value !== 'string' || !START_SEED_PATTERN.test(value)) {
    return false;
  }

  try {
    return BigInt(value) <= MAX_START_SEED;
  } catch {
    return false;
  }
}

/**
 * Registers validation for Marathon Match start seed request fields.
 * @param validationOptions Optional class-validator message and grouping options.
 * @returns Property decorator that validates decimal string BIGINT seed values.
 */
function IsStartSeed(validationOptions?: ValidationOptions): PropertyDecorator {
  return (object: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isStartSeed',
      target: object.constructor,
      propertyName: String(propertyName),
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return isStartSeed(value);
        },
        defaultMessage: () =>
          'startSeed must be a non-negative 64-bit integer string between 0 and 9223372036854775807.',
      },
    });
  };
}

/**
 * Base payload for phase-specific marathon match execution settings.
 * Used for nested phase config input and response mapping.
 */
export class PhaseConfigDto {
  @ApiProperty({
    description: 'Phase configuration type',
    enum: PhaseConfigType,
    example: PhaseConfigType.EXAMPLE,
  })
  @IsEnum(PhaseConfigType)
  configType: PhaseConfigType;

  @ApiProperty({
    description:
      'Starting seed for test generation as a decimal string. Values are stored as PostgreSQL BIGINT and passed to the Java runner as a long. Existing numeric JSON input is accepted only when it is a safe integer; send large 64-bit seeds as strings.',
    type: String,
    format: 'int64',
    example: '12345',
  })
  @Transform(({ value }: TransformFnParams) => transformStartSeed(value))
  @IsStartSeed()
  startSeed: string;

  @ApiProperty({
    description: 'Number of tests to execute for this phase',
    example: 20,
  })
  @IsInt()
  @Min(1)
  numberOfTests: number;

  @ApiProperty({
    description:
      'Canonical challenge-api phase definition ID from `phases[].phaseId` (not the challenge-phase row `id`).',
    example: '12345678-abcd-1234-abcd-1234567890ab',
  })
  @IsString()
  @IsNotEmpty()
  phaseId: string;
}

/**
 * Request payload for creating a marathon match configuration.
 * Used by POST /challenge/:challengeId.
 */
export class CreateMarathonMatchConfigDto {
  @ApiProperty({
    description: 'Display name for this marathon match configuration',
    example: 'MM June 2026 Config',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({
    description: 'Whether this configuration is active',
    required: false,
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    description:
      'Whether review scores should be recomputed relative to the latest submission from each competitor.',
    required: false,
    default: true,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  relativeScoringEnabled?: boolean;

  @ApiProperty({
    description:
      'Defines whether larger raw testcase scores are better or smaller raw testcase scores are better when relative scoring is enabled.',
    required: false,
    enum: ScoreDirection,
    default: ScoreDirection.MAXIMIZE,
    example: ScoreDirection.MAXIMIZE,
  })
  @IsOptional()
  @IsEnum(ScoreDirection)
  scoreDirection?: ScoreDirection;

  @ApiProperty({
    description: 'Submission API base URL',
    required: false,
    default: 'https://api.topcoder-dev.com/v6',
    example: 'https://api.topcoder-dev.com/v6',
  })
  @IsOptional()
  @IsUrl()
  submissionApiUrl?: string;

  @ApiProperty({
    description:
      'Review scorecard identifier used for provisional/system review flow. Supports review-api scorecard id or legacy id.',
    example: 'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
  })
  @IsString()
  @IsNotEmpty()
  reviewScorecardId: string;

  @ApiProperty({
    description: 'Tester ID used to compile and run submissions',
    example: 'V1StGXR8_Z5jdH',
  })
  @IsString()
  @IsNotEmpty()
  testerId: string;

  @ApiProperty({
    description: 'Test execution timeout in milliseconds',
    example: 90000,
  })
  @IsInt()
  @Min(1)
  testTimeout: number;

  @ApiProperty({
    description: 'Compilation timeout in milliseconds',
    example: 120000,
  })
  @IsInt()
  @Min(1)
  compileTimeout: number;

  @ApiProperty({
    description: 'ECS task definition name for submission execution',
    example: 'mm-submission-runner',
  })
  @IsString()
  @IsNotEmpty()
  taskDefinitionName: string;

  @ApiProperty({
    description: 'Task definition version for submission execution',
    example: '42',
  })
  @IsString()
  @IsNotEmpty()
  taskDefinitionVersion: string;

  @ApiProperty({
    description: 'Optional EXAMPLE phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  example?: PhaseConfigDto;

  @ApiProperty({
    description: 'Optional PROVISIONAL phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  provisional?: PhaseConfigDto;

  @ApiProperty({
    description: 'Optional SYSTEM phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  system?: PhaseConfigDto;
}

/**
 * Request payload for partially updating a marathon match configuration.
 * Used by PUT /challenge/:challengeId.
 */
export class UpdateMarathonMatchConfigDto {
  @ApiProperty({
    description: 'Display name for this marathon match configuration',
    required: false,
    example: 'MM June 2026 Config',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiProperty({
    description: 'Whether this configuration is active',
    required: false,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    description:
      'Whether review scores should be recomputed relative to the latest submission from each competitor.',
    required: false,
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  relativeScoringEnabled?: boolean;

  @ApiProperty({
    description:
      'Defines whether larger raw testcase scores are better or smaller raw testcase scores are better when relative scoring is enabled.',
    required: false,
    enum: ScoreDirection,
    example: ScoreDirection.MAXIMIZE,
  })
  @IsOptional()
  @IsEnum(ScoreDirection)
  scoreDirection?: ScoreDirection;

  @ApiProperty({
    description: 'Submission API base URL',
    required: false,
    example: 'https://api.topcoder-dev.com/v6',
  })
  @IsOptional()
  @IsUrl()
  submissionApiUrl?: string;

  @ApiProperty({
    description:
      'Review scorecard identifier used for provisional/system review flow. Supports review-api scorecard id or legacy id.',
    required: false,
    example: 'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  reviewScorecardId?: string;

  @ApiProperty({
    description: 'Tester ID used to compile and run submissions',
    required: false,
    example: 'V1StGXR8_Z5jdH',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  testerId?: string;

  @ApiProperty({
    description: 'Test execution timeout in milliseconds',
    required: false,
    example: 90000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  testTimeout?: number;

  @ApiProperty({
    description: 'Compilation timeout in milliseconds',
    required: false,
    example: 120000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  compileTimeout?: number;

  @ApiProperty({
    description: 'ECS task definition name for submission execution',
    required: false,
    example: 'mm-submission-runner',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  taskDefinitionName?: string;

  @ApiProperty({
    description: 'Task definition version for submission execution',
    required: false,
    example: '42',
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  taskDefinitionVersion?: string;

  @ApiProperty({
    description: 'EXAMPLE phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  example?: PhaseConfigDto;

  @ApiProperty({
    description: 'PROVISIONAL phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  provisional?: PhaseConfigDto;

  @ApiProperty({
    description: 'SYSTEM phase configuration',
    type: PhaseConfigDto,
    required: false,
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => PhaseConfigDto)
  system?: PhaseConfigDto;
}

/**
 * Response representation of configurable default values for new marathon match configs.
 * Returned by GET /challenge/defaults for UI pre-population.
 */
export class MarathonMatchDefaultsResponseDto {
  @ApiProperty({
    description: 'Default review scorecard ID',
    example: 'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
  })
  reviewScorecardId: string;

  @ApiProperty({
    description: 'Default test timeout in ms',
    example: 90000,
  })
  testTimeout: number;

  @ApiProperty({
    description: 'Default compile timeout in ms',
    example: 120000,
  })
  compileTimeout: number;

  @ApiProperty({
    description:
      'Default ECS task definition name used to pre-fill new configs. Empty string when not configured.',
    example: 'mm-submission-runner',
  })
  taskDefinitionName: string;

  @ApiProperty({
    description:
      'Default ECS task definition version used to pre-fill new configs. Empty string when not configured.',
    example: '42',
  })
  taskDefinitionVersion: string;
}

/**
 * Response representation for persisted phase configuration records.
 * Returned as nested properties in marathon match config responses.
 */
export class PhaseConfigResponseDto extends PhaseConfigDto {
  @ApiProperty({
    description: 'Unique phase config ID',
    example: 'V1StGXR8_Z5jdH',
  })
  id: string;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2026-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2026-01-01T00:00:00.000Z',
  })
  updatedAt: Date;
}

/**
 * Response representation of a marathon match configuration.
 * Returned by create, update, get and list config endpoints.
 */
export class MarathonMatchConfigResponseDto {
  @ApiProperty({
    description: 'Unique marathon match configuration ID',
    example: 'V1StGXR8_Z5jdH',
  })
  id: string;

  @ApiProperty({
    description: 'Challenge ID',
    example: '30000123',
  })
  challengeId: string;

  @ApiProperty({
    description: 'Display name of the marathon match configuration',
    example: 'MM June 2026 Config',
  })
  name: string;

  @ApiProperty({
    description: 'Whether the configuration is active',
    example: true,
  })
  active: boolean;

  @ApiProperty({
    description:
      'Whether review scores are recomputed relative to the latest submission from each competitor.',
    example: true,
  })
  relativeScoringEnabled: boolean;

  @ApiProperty({
    description:
      'Defines whether larger raw testcase scores are better or smaller raw testcase scores are better when relative scoring is enabled.',
    enum: ScoreDirection,
    example: ScoreDirection.MAXIMIZE,
  })
  scoreDirection: ScoreDirection;

  @ApiProperty({
    description: 'Submission API base URL',
    example: 'https://api.topcoder-dev.com/v6',
  })
  submissionApiUrl: string;

  @ApiProperty({
    description: 'Resolved review scorecard id configured for this challenge',
    example: 'f6f937cb-3b71-43fd-8ecf-2f0d76db44db',
  })
  reviewScorecardId: string;

  @ApiProperty({
    description: 'Tester ID associated with this config',
    example: 'V1StGXR8_Z5jdH',
  })
  testerId: string;

  @ApiProperty({
    description: 'Test execution timeout in milliseconds',
    example: 90000,
  })
  testTimeout: number;

  @ApiProperty({
    description: 'Compilation timeout in milliseconds',
    example: 120000,
  })
  compileTimeout: number;

  @ApiProperty({
    description: 'ECS task definition name',
    example: 'mm-submission-runner',
  })
  taskDefinitionName: string;

  @ApiProperty({
    description: 'ECS task definition version',
    example: '42',
  })
  taskDefinitionVersion: string;

  @ApiProperty({
    description: 'EXAMPLE phase config or null when absent',
    type: PhaseConfigResponseDto,
    nullable: true,
    example: null,
  })
  example: PhaseConfigResponseDto | null;

  @ApiProperty({
    description: 'PROVISIONAL phase config or null when absent',
    type: PhaseConfigResponseDto,
    nullable: true,
    example: null,
  })
  provisional: PhaseConfigResponseDto | null;

  @ApiProperty({
    description: 'SYSTEM phase config or null when absent',
    type: PhaseConfigResponseDto,
    nullable: true,
    example: null,
  })
  system: PhaseConfigResponseDto | null;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2026-01-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2026-01-01T00:00:00.000Z',
  })
  updatedAt: Date;

  @ApiProperty({
    description: 'User ID that created this config',
    nullable: true,
    example: '40166514',
  })
  createdBy: string | null;

  @ApiProperty({
    description: 'User ID that last updated this config',
    nullable: true,
    example: '40166514',
  })
  updatedBy: string | null;
}

/**
 * Response payload for a rerun request across the latest challenge submissions.
 * Returned by POST /challenge/:challengeId/rerun after ECS tasks are dispatched.
 */
export class RerunResponseDto {
  @ApiProperty({
    description: 'Challenge ID for the rerun request',
    example: '30000123',
  })
  challengeId: string;

  @ApiProperty({
    description: 'Number of latest submissions selected for rerun dispatch',
    example: 12,
  })
  submissionsQueued: number;

  @ApiProperty({
    description:
      'Per-submission launch results for the rerun request, including any dispatch errors.',
    type: 'array',
    items: {
      type: 'object',
      required: ['submissionId'],
      properties: {
        submissionId: {
          type: 'string',
          description: 'Submission identifier that was selected for rerun',
          example: '7f6d7b6c-4b8a-4e1d-b5cf-1a2b3c4d5e6f',
        },
        taskArn: {
          type: 'string',
          description: 'AWS ECS task ARN when the scorer task launch succeeded',
          example:
            'arn:aws:ecs:us-east-1:123456789012:task/cluster/0123456789abcdef',
          nullable: true,
        },
        taskId: {
          type: 'string',
          description:
            'Short ECS task identifier when the scorer task launch succeeded',
          example: '0123456789abcdef',
          nullable: true,
        },
        error: {
          type: 'string',
          description:
            'Launch error message when dispatch failed for that submission',
          example: 'Failed to get M2M token for ECS task launch.',
          nullable: true,
        },
      },
    },
  })
  results: Array<{
    submissionId: string;
    taskArn?: string;
    taskId?: string;
    error?: string;
  }>;
}

/**
 * Pagination metadata for marathon match config list endpoints.
 */
export class PaginationMetaDto {
  @ApiProperty({ example: 100 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 10 })
  perPage: number;

  @ApiProperty({ example: 10 })
  totalPages: number;
}

/**
 * Paginated response for marathon match config search requests.
 * Used by GET /challenge.
 */
export class MarathonMatchConfigPaginatedResponseDto {
  @ApiProperty({ description: 'Pagination metadata' })
  metadata: PaginationMetaDto;

  @ApiProperty({
    description: 'List of marathon match configs matching the query',
    type: [MarathonMatchConfigResponseDto],
  })
  configs: MarathonMatchConfigResponseDto[];
}

/**
 * Query parameters for searching marathon match configs.
 * Supports optional active filtering and pagination.
 */
export class SearchMarathonMatchConfigQueryDto {
  @ApiProperty({
    description: 'Filter by active status',
    required: false,
    type: Boolean,
    example: true,
  })
  @IsOptional()
  @Transform(({ value }: TransformFnParams) => {
    const rawValue: unknown = value;
    if (rawValue === undefined) {
      return undefined;
    }
    if (typeof rawValue === 'boolean') {
      return rawValue;
    }
    if (typeof rawValue === 'string') {
      const normalizedValue = rawValue.trim().toLowerCase();
      if (normalizedValue === 'true') {
        return true;
      }
      if (normalizedValue === 'false') {
        return false;
      }
    }
    return rawValue;
  })
  @IsBoolean()
  active?: boolean;

  @ApiProperty({
    description: 'Page number (starts at 1)',
    required: false,
    type: Number,
    example: 1,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiProperty({
    description: 'Number of records per page',
    required: false,
    type: Number,
    example: 20,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  perPage: number = 20;
}
