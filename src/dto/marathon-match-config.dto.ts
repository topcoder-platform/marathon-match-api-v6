import { ApiProperty } from '@nestjs/swagger';
import { PhaseConfigType } from '@prisma/client';
import { Transform, TransformFnParams, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

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
      'Starting seed for test generation. Maximum is 2147483647 to stay within PostgreSQL Int range. Service runtime also enforces Number.isSafeInteger before persistence.',
    example: 12345,
  })
  @IsInt()
  @Min(0)
  @Max(2147483647)
  startSeed: number;

  @ApiProperty({
    description: 'Number of tests to execute for this phase',
    example: 20,
  })
  @IsInt()
  @Min(1)
  numberOfTests: number;

  @ApiProperty({
    description: 'Challenge API phase ID used for this configuration',
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
    description: 'Submission API base URL',
    required: false,
    default: 'https://api.topcoder-dev.com/v6',
    example: 'https://api.topcoder-dev.com/v6',
  })
  @IsOptional()
  @IsUrl()
  submissionApiUrl?: string;

  @ApiProperty({
    description: 'Review scorecard ID used for provisional/system review flow',
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
    description: 'Submission API base URL',
    required: false,
    example: 'https://api.topcoder-dev.com/v6',
  })
  @IsOptional()
  @IsUrl()
  submissionApiUrl?: string;

  @ApiProperty({
    description: 'Review scorecard ID used for provisional/system review flow',
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
    description: 'Submission API base URL',
    example: 'https://api.topcoder-dev.com/v6',
  })
  submissionApiUrl: string;

  @ApiProperty({
    description: 'Review scorecard ID',
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
