import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Res,
  UseInterceptors,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  CreateTesterVersionDto,
  CreateTesterDto,
  SearchTesterQueryDto,
  TesterPaginatedResponseDto,
  TesterResponseQueryDto,
  TesterResponseDto,
} from 'src/dto/tester.dto';
import { PaginationHeaderInterceptor } from 'src/interceptors/PaginationHeaderInterceptor';
import { Scopes } from 'src/shared/decorators/scopes.decorator';
import { User } from 'src/shared/decorators/user.decorator';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { TesterService, UpdateTesterResult } from './tester.service';

/**
 * Exposes secured tester CRUD endpoints for marathon match admin and copilot
 * workflows.
 */
@ApiTags('Testers')
@ApiBearerAuth()
@Controller('/testers')
export class TesterController {
  constructor(private readonly testerService: TesterService) {}

  /**
   * Creates a tester.
   * @param body Tester create payload.
   * @param user Authenticated user for audit fields.
   * @returns The created tester.
   */
  @Post()
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.CreateMarathonMatchTester)
  @ApiOperation({
    summary: 'Create a tester',
    description: 'Roles: Admin, Copilot | Scopes: create:marathon-match-tester',
  })
  @ApiBody({ description: 'Tester data', type: CreateTesterDto })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse({
    status: 202,
    description:
      'Tester accepted; compilation triggered asynchronously. Poll GET /testers/:id for compilationStatus.',
    type: TesterResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  async createTester(
    @Body() body: CreateTesterDto,
    @User() user: JwtUser,
  ): Promise<TesterResponseDto> {
    return await this.testerService.createTester(body, user);
  }

  /**
   * Creates a new version of an existing tester family.
   * @param id Existing tester ID used to resolve the tester family.
   * @param body New tester-version payload.
   * @param query Response shaping query parameters.
   * @param user Authenticated user for audit fields.
   * @returns The accepted tester version.
   */
  @Put('/:id')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.UpdateMarathonMatchTester)
  @ApiOperation({
    summary: 'Create a tester version',
    description: 'Roles: Admin, Copilot | Scopes: update:marathon-match-tester',
  })
  @ApiParam({
    name: 'id',
    description:
      'The ID of an existing tester record whose family name will be reused for the new version',
    example: 'V1StGXR8_Z5jdH',
  })
  @ApiBody({
    description:
      'New tester-version data. The tester name is inherited from the referenced tester.',
    type: CreateTesterVersionDto,
  })
  @ApiQuery({
    name: 'includeJarFile',
    description:
      'Include compiled jar content in the response. Disabled by default to avoid large payloads. New versions return null until compilation succeeds.',
    required: false,
    type: Boolean,
    example: false,
  })
  @ApiResponse({
    status: 202,
    description:
      'New tester version accepted; compilation triggered asynchronously. Previous versions remain available for lookup.',
    type: TesterResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Bad Request. Returned when the submitted version is not higher than the current max version for that tester family.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  async createTesterVersion(
    @Param('id') id: string,
    @Body() body: CreateTesterVersionDto,
    @Query() query: TesterResponseQueryDto,
    @Res({ passthrough: true }) res: Response,
    @User() user: JwtUser,
  ): Promise<TesterResponseDto> {
    const result: UpdateTesterResult =
      await this.testerService.createTesterVersion(
        id,
        body,
        user,
        query.includeJarFile,
      );
    res.status(HttpStatus.ACCEPTED);
    return result.tester;
  }

  /**
   * Deletes a tester by ID.
   * @param id Tester ID.
   * @returns Deletion confirmation message.
   */
  @Delete(':id')
  @Roles(UserRole.Admin)
  @Scopes(Scope.DeleteMarathonMatchTester)
  @ApiOperation({
    summary: 'Delete a tester',
    description: 'Roles: Admin | Scopes: delete:marathon-match-tester',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the tester',
    example: 'V1StGXR8_Z5jdH',
  })
  @ApiResponse({
    status: 200,
    description: 'Tester deleted successfully.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  @ApiResponse({
    status: 409,
    description:
      'Tester cannot be deleted while referenced by marathon match configs.',
  })
  async deleteTester(@Param('id') id: string): Promise<{ message: string }> {
    return await this.testerService.deleteTester(id);
  }

  /**
   * Retrieves a tester by ID.
   * @param id Tester ID.
   * @param query Response shaping query parameters.
   * @returns Tester details.
   */
  @Get('/:id')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.ReadMarathonMatchTester)
  @ApiOperation({
    summary: 'Get a tester',
    description: 'Roles: Admin, Copilot | Scopes: read:marathon-match-tester',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the tester',
    example: 'V1StGXR8_Z5jdH',
  })
  @ApiQuery({
    name: 'includeJarFile',
    description:
      'Include compiled jar content in the response. Disabled by default to avoid large payloads.',
    required: false,
    type: Boolean,
    example: false,
  })
  @ApiResponse({
    status: 200,
    description:
      'Tester retrieved successfully. jarFile is omitted unless includeJarFile=true.',
    type: TesterResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  async getTester(
    @Param('id') id: string,
    @Query() query: TesterResponseQueryDto,
  ): Promise<TesterResponseDto> {
    return await this.testerService.getTester(id, query.includeJarFile);
  }

  /**
   * Lists testers with optional filters and pagination.
   * @param query Search and pagination query parameters.
   * @returns Paginated tester list.
   */
  @Get()
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.ReadMarathonMatchTester)
  @ApiOperation({
    summary: 'List testers',
    description:
      'Roles: Admin, Copilot | Scopes: read:marathon-match-tester | Supports pagination and optional name filtering.',
  })
  @ApiQuery({
    name: 'name',
    description: 'Filter by tester name (partial match)',
    required: false,
    example: 'java',
  })
  @ApiQuery({
    name: 'page',
    description: 'Page number (starts from 1)',
    required: false,
    type: Number,
    example: 1,
  })
  @ApiQuery({
    name: 'perPage',
    description: 'Number of items per page',
    required: false,
    type: Number,
    example: 20,
  })
  @ApiResponse({
    status: 200,
    description:
      'List of matching testers without sourceCode or jarFile payloads.',
    type: TesterPaginatedResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @UseInterceptors(PaginationHeaderInterceptor)
  async listTesters(
    @Query() query: SearchTesterQueryDto,
  ): Promise<TesterPaginatedResponseDto> {
    return await this.testerService.listTesters(query);
  }
}
