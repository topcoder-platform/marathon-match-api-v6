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
  CreateTesterDto,
  SearchTesterQueryDto,
  TesterPaginatedResponseDto,
  TesterResponseDto,
  UpdateTesterDto,
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
 * Exposes secured tester CRUD endpoints for marathon match admin workflows.
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
  @Roles(UserRole.Admin)
  @Scopes(Scope.CreateMarathonMatchTester)
  @ApiOperation({
    summary: 'Create a tester',
    description: 'Roles: Admin | Scopes: create:marathon-match-tester',
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
   * Updates a tester by ID.
   * @param id Tester ID.
   * @param body Partial tester update payload.
   * @param user Authenticated user for audit fields.
   * @returns The updated tester.
   */
  @Put('/:id')
  @Roles(UserRole.Admin)
  @Scopes(Scope.UpdateMarathonMatchTester)
  @ApiOperation({
    summary: 'Update a tester',
    description: 'Roles: Admin | Scopes: update:marathon-match-tester',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the tester',
    example: 'V1StGXR8_Z5jdH',
  })
  @ApiBody({ description: 'Updated tester data', type: UpdateTesterDto })
  @ApiResponse({
    status: 200,
    description:
      'Tester updated successfully when sourceCode is unchanged or omitted.',
    type: TesterResponseDto,
  })
  @ApiResponse({
    status: 202,
    description: 'Compilation triggered asynchronously.',
    type: TesterResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  async updateTester(
    @Param('id') id: string,
    @Body() body: UpdateTesterDto,
    @Res({ passthrough: true }) res: Response,
    @User() user: JwtUser,
  ): Promise<TesterResponseDto> {
    const result: UpdateTesterResult = await this.testerService.updateTester(
      id,
      body,
      user,
    );
    res.status(
      result.compilationTriggered ? HttpStatus.ACCEPTED : HttpStatus.OK,
    );
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
   * @returns Tester details.
   */
  @Get('/:id')
  @Roles(UserRole.Admin)
  @Scopes(Scope.ReadMarathonMatchTester)
  @ApiOperation({
    summary: 'Get a tester',
    description: 'Roles: Admin | Scopes: read:marathon-match-tester',
  })
  @ApiParam({
    name: 'id',
    description: 'The ID of the tester',
    example: 'V1StGXR8_Z5jdH',
  })
  @ApiResponse({
    status: 200,
    description: 'Tester retrieved successfully.',
    type: TesterResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  async getTester(@Param('id') id: string): Promise<TesterResponseDto> {
    return await this.testerService.getTester(id);
  }

  /**
   * Lists testers with optional filters and pagination.
   * @param query Search and pagination query parameters.
   * @returns Paginated tester list.
   */
  @Get()
  @Roles(UserRole.Admin)
  @Scopes(Scope.ReadMarathonMatchTester)
  @ApiOperation({
    summary: 'List testers',
    description:
      'Roles: Admin | Scopes: read:marathon-match-tester | Supports pagination and optional name filtering.',
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
