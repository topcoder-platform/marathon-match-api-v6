import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  CompilationStatus,
  PhaseConfigType,
  Prisma,
  phaseConfig,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  CreateMarathonMatchConfigDto,
  MarathonMatchConfigPaginatedResponseDto,
  MarathonMatchConfigResponseDto,
  PhaseConfigDto,
  PhaseConfigResponseDto,
  SearchMarathonMatchConfigQueryDto,
  UpdateMarathonMatchConfigDto,
} from 'src/dto/marathon-match-config.dto';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaErrorService } from 'src/shared/modules/global/prisma-error.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

type MarathonMatchConfigWithPhaseConfigs =
  Prisma.marathonMatchConfigGetPayload<{
    include: {
      phaseConfigs: true;
    };
  }>;

/**
 * Handles marathon match configuration CRUD operations and maps
 * persistence records to API response DTOs for challenge config endpoints.
 */
@Injectable()
export class MarathonMatchConfigService {
  private readonly logger = LoggerService.forRoot('MarathonMatchConfigService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly prismaErrorService: PrismaErrorService,
  ) {}

  /**
   * Creates a marathon match configuration and optional phase configs.
   * @param challengeId Challenge ID from path params in POST /challenge/:challengeId.
   * @param body Input payload from POST /challenge/:challengeId.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Created marathon match config mapped to `MarathonMatchConfigResponseDto`.
   * @throws NotFoundException When the referenced tester does not exist.
   * @throws BadRequestException When phase `startSeed` is not a safe integer.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async createConfig(
    challengeId: string,
    body: CreateMarathonMatchConfigDto,
    user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    try {
      const testerData = await this.prisma.tester.findUnique({
        where: { id: body.testerId },
      });

      if (!testerData) {
        throw new NotFoundException(
          `Tester with ID ${body.testerId} not found.`,
        );
      }

      const phaseConfigs: Array<{
        phase: PhaseConfigDto | undefined;
        configType: PhaseConfigType;
      }> = [
        { phase: body.example, configType: PhaseConfigType.EXAMPLE },
        { phase: body.provisional, configType: PhaseConfigType.PROVISIONAL },
        { phase: body.system, configType: PhaseConfigType.SYSTEM },
      ];
      this.validateSafeStartSeeds(challengeId, phaseConfigs);

      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const configId = nanoid(14);
      await this.prisma.$transaction(async (prisma) => {
        await prisma.marathonMatchConfig.create({
          data: {
            id: configId,
            challengeId,
            name: body.name,
            active: body.active,
            relativeScoringEnabled: body.relativeScoringEnabled,
            scoreDirection: body.scoreDirection,
            submissionApiUrl: body.submissionApiUrl,
            reviewScorecardId: body.reviewScorecardId,
            testerId: body.testerId,
            testTimeout: body.testTimeout,
            compileTimeout: body.compileTimeout,
            taskDefinitionName: body.taskDefinitionName,
            taskDefinitionVersion: body.taskDefinitionVersion,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        for (const { phase, configType } of phaseConfigs) {
          if (!phase) {
            continue;
          }

          await prisma.phaseConfig.create({
            data: {
              id: nanoid(14),
              marathonMatchConfigId: configId,
              configType,
              startSeed: phase.startSeed,
              numberOfTests: phase.numberOfTests,
              phaseId: phase.phaseId,
            },
          });
        }
      });

      const createdConfig = await this.fetchConfig(challengeId);
      if (!createdConfig) {
        throw new InternalServerErrorException(
          `Marathon match config ${challengeId} could not be loaded after creation.`,
        );
      }

      return this.mapConfigResponse(createdConfig);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `creating marathon match config with challenge ID: ${challengeId}`,
      );
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Updates a marathon match configuration and upserts requested phase configs.
   * @param challengeId Challenge ID from path params.
   * @param body Partial update payload from PUT /challenge/:challengeId.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Updated marathon match config mapped to `MarathonMatchConfigResponseDto`.
   * @throws NotFoundException When the config or updated tester does not exist.
   * @throws BadRequestException When phase `startSeed` is not a safe integer.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async updateConfig(
    challengeId: string,
    body: UpdateMarathonMatchConfigDto,
    user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    try {
      const existing = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
      });

      if (!existing) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      if (body.testerId && body.testerId !== existing.testerId) {
        const testerData = await this.prisma.tester.findUnique({
          where: { id: body.testerId },
        });

        if (!testerData) {
          throw new NotFoundException(
            `Tester with ID ${body.testerId} not found.`,
          );
        }
      }

      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const { example, provisional, system, ...scalarFields } = body;
      const phaseConfigs: Array<{
        phase: PhaseConfigDto | undefined;
        configType: PhaseConfigType;
      }> = [
        { phase: example, configType: PhaseConfigType.EXAMPLE },
        { phase: provisional, configType: PhaseConfigType.PROVISIONAL },
        { phase: system, configType: PhaseConfigType.SYSTEM },
      ];
      this.validateSafeStartSeeds(challengeId, phaseConfigs);

      await this.prisma.$transaction(async (prisma) => {
        await prisma.marathonMatchConfig.update({
          where: { challengeId },
          data: {
            ...scalarFields,
            updatedBy: actor,
          },
        });

        for (const { phase, configType } of phaseConfigs) {
          if (!phase) {
            continue;
          }

          await prisma.phaseConfig.upsert({
            where: {
              marathonMatchConfigId_configType: {
                marathonMatchConfigId: existing.id,
                configType,
              },
            },
            update: {
              startSeed: phase.startSeed,
              numberOfTests: phase.numberOfTests,
              phaseId: phase.phaseId,
            },
            create: {
              id: nanoid(14),
              marathonMatchConfigId: existing.id,
              configType,
              startSeed: phase.startSeed,
              numberOfTests: phase.numberOfTests,
              phaseId: phase.phaseId,
            },
          });
        }
      });

      const updatedConfig = await this.fetchConfig(challengeId);
      if (!updatedConfig) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      return this.mapConfigResponse(updatedConfig);
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `updating marathon match config with challenge ID: ${challengeId}`,
      );
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Retrieves a marathon match configuration by challenge ID.
   * @param challengeId Challenge ID from path params.
   * @param user Authenticated user or machine token payload.
   * @returns Marathon match config details mapped to `MarathonMatchConfigResponseDto`.
   * @throws NotFoundException When the config does not exist.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async getConfig(
    challengeId: string,
    user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    try {
      const config = await this.fetchConfig(challengeId);
      if (!config) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }
      return this.mapConfigResponse(config);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `retrieving marathon match config with challenge ID: ${challengeId} for actor: ${this.getActor(user)}`,
      );
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Retrieves the compiled tester JAR bytes for a challenge configuration.
   * @param challengeId Challenge ID from path params.
   * @returns Compiled tester JAR bytes for download.
   * @throws NotFoundException When the config is missing or tester JAR is unavailable.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async getTesterJar(challengeId: string): Promise<Buffer> {
    try {
      const config = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
        include: {
          tester: true,
        },
      });

      if (!config) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      if (
        config.tester.compilationStatus !== CompilationStatus.SUCCESS ||
        !config.tester.jarFile
      ) {
        throw new NotFoundException(
          `Tester JAR for challenge ID ${challengeId} is not available yet.`,
        );
      }

      return Buffer.from(config.tester.jarFile);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `retrieving tester jar for challenge ID: ${challengeId}`,
      );
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Deletes a marathon match configuration by challenge ID.
   * @param challengeId Challenge ID from path params.
   * @param user Authenticated user or machine token payload.
   * @returns Confirmation message.
   * @throws NotFoundException When the config does not exist.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async deleteConfig(
    challengeId: string,
    user: JwtUser,
  ): Promise<{ message: string }> {
    try {
      await this.prisma.marathonMatchConfig.delete({
        where: { challengeId },
      });

      return {
        message: `Marathon match config ${challengeId} deleted successfully.`,
      };
    } catch (error) {
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `deleting marathon match config with challenge ID: ${challengeId} for actor: ${this.getActor(user)}`,
      );
      if (errorResponse.code === 'RECORD_NOT_FOUND') {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Lists marathon match configs with optional active filtering and pagination.
   * @param query Query params from GET /challenge.
   * @param user Authenticated user or machine token payload.
   * @returns Paginated marathon match config response payload.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async listConfigs(
    query: SearchMarathonMatchConfigQueryDto,
    user: JwtUser,
  ): Promise<MarathonMatchConfigPaginatedResponseDto> {
    try {
      const { active, page = 1, perPage = 20 } = query;
      const skip = (page - 1) * perPage;
      const where: Prisma.marathonMatchConfigWhereInput = {
        ...(typeof active === 'boolean' && { active }),
      };

      const configs = await this.prisma.marathonMatchConfig.findMany({
        where,
        include: {
          phaseConfigs: true,
        },
        skip,
        take: perPage,
        orderBy: {
          name: 'asc',
        },
      });

      const total = await this.prisma.marathonMatchConfig.count({
        where,
      });

      return {
        metadata: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(total / perPage),
        },
        configs: configs.map((config) => this.mapConfigResponse(config)),
      };
    } catch (error) {
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `listing marathon match configs with filters: ${JSON.stringify(query)} for actor: ${this.getActor(user)}`,
      );
      this.logger.error(errorResponse.message);
      throw new InternalServerErrorException({
        message: errorResponse.message,
        code: errorResponse.code,
        details: errorResponse.details,
      });
    }
  }

  /**
   * Loads a marathon match config with all associated phase configs.
   * @param challengeId Challenge ID for the config.
   * @returns Config record with related phase configs, or null when missing.
   */
  private async fetchConfig(
    challengeId: string,
  ): Promise<MarathonMatchConfigWithPhaseConfigs | null> {
    return await this.prisma.marathonMatchConfig.findUnique({
      where: { challengeId },
      include: {
        phaseConfigs: true,
      },
    });
  }

  /**
   * Maps Prisma config records and flat phase relation arrays into API DTO shape.
   * @param config Prisma config record with related phase configs.
   * @returns Marathon match config response DTO with typed phase keys.
   */
  private mapConfigResponse(
    config: MarathonMatchConfigWithPhaseConfigs,
  ): MarathonMatchConfigResponseDto {
    const mapPhaseByType = (
      configType: PhaseConfigType,
    ): PhaseConfigResponseDto | null => {
      const phase = config.phaseConfigs.find(
        (phaseConfigData) => phaseConfigData.configType === configType,
      );
      return phase ? this.mapPhaseConfigResponse(phase) : null;
    };

    return {
      id: config.id,
      challengeId: config.challengeId,
      name: config.name,
      active: config.active,
      relativeScoringEnabled: config.relativeScoringEnabled,
      scoreDirection: config.scoreDirection,
      submissionApiUrl: config.submissionApiUrl,
      reviewScorecardId: config.reviewScorecardId,
      testerId: config.testerId,
      testTimeout: config.testTimeout,
      compileTimeout: config.compileTimeout,
      taskDefinitionName: config.taskDefinitionName,
      taskDefinitionVersion: config.taskDefinitionVersion,
      example: mapPhaseByType(PhaseConfigType.EXAMPLE),
      provisional: mapPhaseByType(PhaseConfigType.PROVISIONAL),
      system: mapPhaseByType(PhaseConfigType.SYSTEM),
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
      createdBy: config.createdBy,
      updatedBy: config.updatedBy,
    };
  }

  /**
   * Maps a single Prisma phase config record to its response DTO.
   * @param phaseConfigData Prisma phase config record.
   * @returns Phase config response DTO.
   */
  private mapPhaseConfigResponse(
    phaseConfigData: phaseConfig,
  ): PhaseConfigResponseDto {
    return {
      id: phaseConfigData.id,
      configType: phaseConfigData.configType,
      startSeed: phaseConfigData.startSeed,
      numberOfTests: phaseConfigData.numberOfTests,
      phaseId: phaseConfigData.phaseId,
      createdAt: phaseConfigData.createdAt,
      updatedAt: phaseConfigData.updatedAt,
    };
  }

  /**
   * Enforces runtime numeric safety for phase start seeds before persistence.
   * DTO validation covers DB range constraints (e.g. @Max(2147483647)),
   * while this check guarantees `Number.isSafeInteger` in service flows.
   * @param challengeId Challenge ID for context in validation errors.
   * @param phaseConfigs Candidate phase configs to validate.
   * @throws BadRequestException When any phase `startSeed` is not a safe integer.
   */
  private validateSafeStartSeeds(
    challengeId: string,
    phaseConfigs: Array<{
      phase: PhaseConfigDto | undefined;
      configType: PhaseConfigType;
    }>,
  ): void {
    for (const { phase, configType } of phaseConfigs) {
      if (!phase) {
        continue;
      }

      if (!Number.isSafeInteger(phase.startSeed)) {
        throw new BadRequestException(
          `Invalid startSeed for ${configType} phase in challenge ${challengeId}. startSeed must be a safe integer.`,
        );
      }
    }
  }

  /**
   * Resolves an actor string for audit-aware logging and error context.
   * @param user Authenticated user or machine token payload.
   * @returns Actor identifier string.
   */
  private getActor(user: JwtUser): string {
    return user.isMachine ? 'System' : (user.userId ?? 'Unknown');
  }
}
