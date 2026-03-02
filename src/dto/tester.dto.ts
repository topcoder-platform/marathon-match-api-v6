import { ApiProperty } from '@nestjs/swagger';
import { CompilationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Min } from 'class-validator';

/**
 * Request payload for creating a tester record.
 * Used by the tester controller for POST /testers requests.
 */
export class CreateTesterDto {
  @ApiProperty({
    description: 'Name of the tester',
    example: 'Marathon Match Java Tester',
  })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Version of the tester', example: '1.0.0' })
  @IsString()
  @IsNotEmpty()
  version: string;

  @ApiProperty({
    description: 'Source code used to build the tester',
    example: 'public class Tester { }',
  })
  @IsString()
  @IsNotEmpty()
  sourceCode: string;

  @ApiProperty({
    description: 'Main class name for the tester',
    example: 'com.topcoder.mm.Tester',
  })
  @IsString()
  @IsNotEmpty()
  className: string;
}

/**
 * Request payload for updating a tester.
 * Used by PUT /testers/:id and supports partial updates.
 */
export class UpdateTesterDto {
  @ApiProperty({
    description: 'Name of the tester',
    example: 'Marathon Match Java Tester',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  name?: string;

  @ApiProperty({
    description: 'Version of the tester',
    example: '1.0.1',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  version?: string;

  @ApiProperty({
    description: 'Source code used to build the tester',
    example: 'public class Tester { }',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  sourceCode?: string;

  @ApiProperty({
    description: 'Main class name for the tester',
    example: 'com.topcoder.mm.Tester',
    required: false,
  })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  className?: string;
}

/**
 * Response representation of a tester record.
 * Returned by create, update, get and list tester endpoints.
 */
export class TesterResponseDto {
  @ApiProperty({ description: 'Unique tester ID', example: 'V1StGXR8_Z5jdH' })
  id: string;

  @ApiProperty({ description: 'Name of the tester', example: 'MM Tester' })
  name: string;

  @ApiProperty({ description: 'Version of the tester', example: '1.0.0' })
  version: string;

  @ApiProperty({
    description: 'Source code used to compile the tester',
    example: 'public class Tester { }',
  })
  sourceCode: string;

  @ApiProperty({
    description: 'Main class name for the tester',
    example: 'com.topcoder.mm.Tester',
  })
  className: string;

  @ApiProperty({
    description: 'Compilation status of the tester source',
    enum: CompilationStatus,
    example: CompilationStatus.PENDING,
  })
  compilationStatus: CompilationStatus;

  @ApiProperty({
    description: 'Compilation error details when compilation failed',
    nullable: true,
    example: null,
  })
  compilationError: string | null;

  @ApiProperty({
    description: 'Compiled jar content as a base64-encoded string',
    nullable: true,
    example: null,
  })
  jarFile: string | null;

  @ApiProperty({
    description: 'Creation timestamp',
    example: '2025-10-01T00:00:00.000Z',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Last update timestamp',
    example: '2025-10-01T00:00:00.000Z',
  })
  updatedAt: Date;

  @ApiProperty({
    description: 'User ID that created this tester',
    nullable: true,
    example: '40166514',
  })
  createdBy: string | null;

  @ApiProperty({
    description: 'User ID that last updated this tester',
    nullable: true,
    example: '40166514',
  })
  updatedBy: string | null;
}

/**
 * Pagination metadata for list endpoints.
 * Included alongside paginated tester results.
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
 * Paginated response for tester search requests.
 * Used by GET /testers.
 */
export class TesterPaginatedResponseDto {
  @ApiProperty({ description: 'Pagination metadata' })
  metadata: PaginationMetaDto;

  @ApiProperty({
    description: 'List of testers matching the query',
    type: [TesterResponseDto],
  })
  testers: TesterResponseDto[];
}

/**
 * Query parameters for searching testers.
 * Supports optional name filtering and pagination.
 */
export class SearchTesterQueryDto {
  @ApiProperty({
    description: 'Tester name filter (partial, case-insensitive)',
    required: false,
    example: 'java',
  })
  @IsOptional()
  @IsString()
  name?: string;

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
