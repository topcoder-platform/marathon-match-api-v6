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
  CreateMarathonMatchConfigDto,
  MarathonMatchConfigPaginatedResponseDto,
  MarathonMatchConfigResponseDto,
  MarathonMatchDefaultsResponseDto,
  RerunResponseDto,
  SearchMarathonMatchConfigQueryDto,
  UpdateMarathonMatchConfigDto,
} from 'src/dto/marathon-match-config.dto';
import { PaginationHeaderInterceptor } from 'src/interceptors/PaginationHeaderInterceptor';
import { Scopes } from 'src/shared/decorators/scopes.decorator';
import { User } from 'src/shared/decorators/user.decorator';
import { Scope } from 'src/shared/enums/scopes.enum';
import { UserRole } from 'src/shared/enums/userRole.enum';
import { Roles } from 'src/shared/guards/tokenRoles.guard';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { MarathonMatchConfigService } from './marathon-match-config.service';

/**
 * Exposes secured marathon match configuration endpoints for admin and copilot
 * setup workflows.
 */
@ApiTags('Marathon Match Config')
@ApiBearerAuth()
@Controller('/challenge')
export class MarathonMatchConfigController {
  constructor(
    private readonly marathonMatchConfigService: MarathonMatchConfigService,
  ) {}

  /**
   * Creates a marathon match configuration.
   * @param challengeId Challenge ID.
   * @param body Config create payload.
   * @param user Authenticated user for audit fields.
   * @returns The created marathon match config.
   */
  @Post('/:challengeId')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.CreateMarathonMatch)
  @ApiOperation({
    summary: 'Create a marathon match config',
    description: 'Roles: Admin, Copilot | Scopes: create:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID for the marathon match config to create',
    example: '30000123',
  })
  @ApiBody({
    description: 'Marathon match configuration data',
    type: CreateMarathonMatchConfigDto,
  })
  @HttpCode(HttpStatus.CREATED)
  @ApiResponse({
    status: 201,
    description: 'Marathon match config created successfully.',
    type: MarathonMatchConfigResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Tester not found.' })
  async createConfig(
    @Param('challengeId') challengeId: string,
    @Body() body: CreateMarathonMatchConfigDto,
    @User() user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    return await this.marathonMatchConfigService.createConfig(
      challengeId,
      body,
      user,
    );
  }

  /**
   * Reruns the latest submissions for a marathon match configuration.
   * @param challengeId Challenge ID.
   * @param user Authenticated user for audit context.
   * @returns Accepted rerun dispatch summary.
   */
  @Post('/:challengeId/rerun')
  @Roles(UserRole.Admin)
  @Scopes(Scope.UpdateMarathonMatch)
  @ApiOperation({
    summary: 'Rerun latest submissions for a Marathon Match challenge',
    description: 'Roles: Admin | Scopes: update:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID for the marathon match config rerun request',
    example: '30000123',
  })
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiResponse({
    status: 202,
    description: 'Latest submissions queued for asynchronous rerun dispatch.',
    type: RerunResponseDto,
  })
  @ApiResponse({
    status: 400,
    description:
      'Challenge/config inactive, challenge has no open phase, tester is not compiled successfully, or PROVISIONAL phase config is missing.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Marathon match config not found.' })
  async rerunLatestSubmissions(
    @Param('challengeId') challengeId: string,
    @User() user: JwtUser,
  ): Promise<RerunResponseDto> {
    return await this.marathonMatchConfigService.rerunLatestSubmissions(
      challengeId,
      user,
    );
  }

  /**
   * Lists marathon match configurations with optional filters and pagination.
   * @param query Search and pagination query parameters.
   * @param user Authenticated user for audit fields.
   * @returns Paginated config list.
   */
  @Get()
  @Roles(UserRole.Admin)
  @Scopes(Scope.ReadMarathonMatch)
  @ApiOperation({
    summary: 'List marathon match configs',
    description:
      'Roles: Admin | Scopes: read:marathon-match | Supports pagination and optional active filtering.',
  })
  @ApiQuery({
    name: 'active',
    description: 'Filter by active status',
    required: false,
    type: Boolean,
    example: true,
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
    description: 'List of marathon match configs.',
    type: MarathonMatchConfigPaginatedResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @UseInterceptors(PaginationHeaderInterceptor)
  async listConfigs(
    @Query() query: SearchMarathonMatchConfigQueryDto,
    @User() user: JwtUser,
  ): Promise<MarathonMatchConfigPaginatedResponseDto> {
    return await this.marathonMatchConfigService.listConfigs(query, user);
  }

  /**
   * Streams the compiled tester JAR for a challenge configuration.
   * @param challengeId Challenge ID.
   * @param res HTTP response used for download headers and binary payload.
   * @returns Promise that resolves after writing binary response.
   */
  @Get('/:challengeId/tester-jar')
  @Roles(UserRole.Admin)
  @Scopes(Scope.ReadMarathonMatch)
  @ApiOperation({
    summary: 'Download tester JAR',
    description: 'Roles: Admin | Scopes: read:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID of the marathon match config',
    example: '30000123',
  })
  @ApiResponse({
    status: 200,
    description: 'Compiled tester JAR stream.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({
    status: 404,
    description:
      'Marathon match config not found or tester JAR is unavailable.',
  })
  async getTesterJar(
    @Param('challengeId') challengeId: string,
    @Res() res: Response,
  ): Promise<void> {
    const jar = await this.marathonMatchConfigService.getTesterJar(challengeId);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', 'attachment; filename="tester.jar"');
    res.send(jar);
  }

  /**
   * Retrieves default marathon match configuration values used to pre-populate the UI.
   * @returns Default review scorecard ID, test timeout, compile timeout, and task definition values.
   */
  @Get('/defaults')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.ReadMarathonMatch)
  @ApiOperation({
    summary: 'Get marathon match config defaults',
    description: 'Roles: Admin, Copilot | Scopes: read:marathon-match',
  })
  @ApiResponse({
    status: 200,
    description: 'Marathon match config defaults retrieved successfully.',
    type: MarathonMatchDefaultsResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 500, description: 'Internal Server Error.' })
  getDefaults(): MarathonMatchDefaultsResponseDto {
    return this.marathonMatchConfigService.getDefaults();
  }

  /**
   * Retrieves a marathon match configuration by challenge ID.
   * @param challengeId Challenge ID.
   * @param user Authenticated user for audit context.
   * @returns Marathon match config details.
   */
  @Get('/:challengeId')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.ReadMarathonMatch)
  @ApiOperation({
    summary: 'Get a marathon match config',
    description: 'Roles: Admin, Copilot | Scopes: read:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID of the marathon match config',
    example: '30000123',
  })
  @ApiResponse({
    status: 200,
    description: 'Marathon match config retrieved successfully.',
    type: MarathonMatchConfigResponseDto,
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Marathon match config not found.' })
  async getConfig(
    @Param('challengeId') challengeId: string,
    @User() user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    return await this.marathonMatchConfigService.getConfig(challengeId, user);
  }

  /**
   * Updates a marathon match configuration by challenge ID.
   * @param challengeId Challenge ID.
   * @param body Partial config update payload.
   * @param user Authenticated user for audit fields.
   * @returns Updated marathon match configuration.
   */
  @Put('/:challengeId')
  @Roles(UserRole.Admin, UserRole.Copilot)
  @Scopes(Scope.UpdateMarathonMatch)
  @ApiOperation({
    summary: 'Update a marathon match config',
    description: 'Roles: Admin, Copilot | Scopes: update:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID of the marathon match config',
    example: '30000123',
  })
  @ApiBody({
    description: 'Updated marathon match configuration data',
    type: UpdateMarathonMatchConfigDto,
  })
  @ApiResponse({
    status: 200,
    description: 'Marathon match config updated successfully.',
    type: MarathonMatchConfigResponseDto,
  })
  @ApiResponse({ status: 400, description: 'Bad Request.' })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({
    status: 404,
    description: 'Marathon match config or tester not found.',
  })
  async updateConfig(
    @Param('challengeId') challengeId: string,
    @Body() body: UpdateMarathonMatchConfigDto,
    @User() user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    return await this.marathonMatchConfigService.updateConfig(
      challengeId,
      body,
      user,
    );
  }

  /**
   * Deletes a marathon match configuration by challenge ID.
   * @param challengeId Challenge ID.
   * @param user Authenticated user for audit context.
   * @returns Deletion confirmation message.
   */
  @Delete('/:challengeId')
  @Roles(UserRole.Admin)
  @Scopes(Scope.DeleteMarathonMatch)
  @ApiOperation({
    summary: 'Delete a marathon match config',
    description: 'Roles: Admin | Scopes: delete:marathon-match',
  })
  @ApiParam({
    name: 'challengeId',
    description: 'The challenge ID of the marathon match config',
    example: '30000123',
  })
  @ApiResponse({
    status: 200,
    description: 'Marathon match config deleted successfully.',
  })
  @ApiResponse({ status: 403, description: 'Forbidden.' })
  @ApiResponse({ status: 404, description: 'Marathon match config not found.' })
  async deleteConfig(
    @Param('challengeId') challengeId: string,
    @User() user: JwtUser,
  ): Promise<{ message: string }> {
    return await this.marathonMatchConfigService.deleteConfig(
      challengeId,
      user,
    );
  }
}
