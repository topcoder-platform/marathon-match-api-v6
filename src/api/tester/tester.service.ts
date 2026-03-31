import {
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CompilationStatus, Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  CreateTesterDto,
  SearchTesterQueryDto,
  TesterPaginatedResponseDto,
  TesterResponseDto,
  TesterSummaryResponseDto,
  UpdateTesterDto,
} from 'src/dto/tester.dto';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaErrorService } from 'src/shared/modules/global/prisma-error.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import { TesterCompilationService } from './tester-compilation.service';

export interface UpdateTesterResult {
  tester: TesterResponseDto;
  compilationTriggered: boolean;
}

const testerListSelect = {
  id: true,
  name: true,
  version: true,
  className: true,
  compilationStatus: true,
  compilationError: true,
  createdAt: true,
  updatedAt: true,
  createdBy: true,
  updatedBy: true,
} satisfies Prisma.testerSelect;

const testerResponseSelect = {
  ...testerListSelect,
  sourceCode: true,
} satisfies Prisma.testerSelect;

const testerResponseWithJarSelect = {
  ...testerResponseSelect,
  jarFile: true,
} satisfies Prisma.testerSelect;

type TesterListRecord = Prisma.testerGetPayload<{
  select: typeof testerListSelect;
}>;

type TesterResponseRecord = Prisma.testerGetPayload<{
  select: typeof testerResponseWithJarSelect;
}>;

type TesterResponseWithoutJarRecord = Prisma.testerGetPayload<{
  select: typeof testerResponseSelect;
}>;

/**
 * Handles tester CRUD operations and maps persistence records
 * to API response DTOs for the marathon match tester endpoints.
 */
@Injectable()
export class TesterService {
  private readonly logger = LoggerService.forRoot('TesterService');

  constructor(
    private readonly prisma: PrismaService,
    private readonly prismaErrorService: PrismaErrorService,
    private readonly testerCompilationService: TesterCompilationService,
  ) {}

  /**
   * Creates a tester record.
   * @param body Input payload from POST /testers.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Created tester mapped to `TesterResponseDto` with `PENDING` compile state.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async createTester(
    body: CreateTesterDto,
    user: JwtUser,
  ): Promise<TesterResponseDto> {
    try {
      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const created = await this.prisma.tester.create({
        data: {
          id: nanoid(14),
          ...body,
          compilationStatus: CompilationStatus.PENDING,
          compilationError: null,
          jarFile: null,
          createdBy: actor,
          updatedBy: actor,
        },
        select: testerResponseSelect,
      });

      this.triggerCompilation(created.id, created.sourceCode);

      return this.mapTesterResponse({
        ...created,
        compilationStatus: CompilationStatus.PENDING,
        jarFile: null,
      });
    } catch (error) {
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `creating tester with name: ${body.name}`,
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
   * Updates a tester record by ID.
   * @param id Tester identifier.
   * @param body Partial update payload.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @param includeJarFile When true, includes the compiled jar payload.
   * @returns Updated tester mapped to `TesterResponseDto` plus compile trigger metadata.
   * Recompilation is triggered asynchronously only when `sourceCode` changed.
   * @throws NotFoundException When the tester does not exist.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async updateTester(
    id: string,
    body: UpdateTesterDto,
    user: JwtUser,
    includeJarFile: boolean = false,
  ): Promise<UpdateTesterResult> {
    try {
      const existing = await this.prisma.tester.findUnique({
        where: { id },
        select: {
          sourceCode: true,
        },
      });

      if (!existing) {
        throw new NotFoundException(`Tester with ID ${id} not found.`);
      }

      const sourceCodeChanged =
        typeof body.sourceCode === 'string' &&
        body.sourceCode !== existing.sourceCode;
      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const updated = await this.prisma.tester.update({
        where: { id },
        data: {
          ...body,
          ...(sourceCodeChanged && {
            compilationStatus: CompilationStatus.PENDING,
            compilationError: null,
            jarFile: null,
          }),
          updatedBy: actor,
        },
        select: includeJarFile
          ? testerResponseWithJarSelect
          : testerResponseSelect,
      });

      if (sourceCodeChanged) {
        this.triggerCompilation(updated.id, updated.sourceCode);
      }

      return {
        tester: this.mapTesterResponse(updated),
        compilationTriggered: sourceCodeChanged,
      };
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `updating tester with ID: ${id}`,
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
   * Deletes a tester record by ID.
   * @param id Tester identifier.
   * @returns Confirmation message.
   * @throws NotFoundException When the tester does not exist.
   * @throws ConflictException When the tester is referenced by marathon match configs.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async deleteTester(id: string): Promise<{ message: string }> {
    try {
      await this.prisma.tester.delete({
        where: { id },
      });
      return { message: `Tester ${id} deleted successfully.` };
    } catch (error) {
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `deleting tester with ID: ${id}`,
      );
      if (errorResponse.code === 'RECORD_NOT_FOUND') {
        throw new NotFoundException(`Tester with ID ${id} not found.`);
      }
      if (errorResponse.code === 'FOREIGN_KEY_CONSTRAINT_FAILED') {
        throw new ConflictException({
          message:
            'Tester cannot be deleted while referenced by marathon match configs.',
          code: errorResponse.code,
          details: errorResponse.details,
        });
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
   * Retrieves a single tester by ID.
   * @param id Tester identifier.
   * @param includeJarFile When true, includes the compiled jar payload.
   * @returns Tester details mapped to `TesterResponseDto`.
   * @throws NotFoundException When the tester does not exist.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async getTester(
    id: string,
    includeJarFile: boolean = false,
  ): Promise<TesterResponseDto> {
    try {
      const testerData = await this.prisma.tester.findUnique({
        where: { id },
        select: includeJarFile
          ? testerResponseWithJarSelect
          : testerResponseSelect,
      });

      if (!testerData) {
        throw new NotFoundException(`Tester with ID ${id} not found.`);
      }

      return this.mapTesterResponse(testerData);
    } catch (error) {
      if (error instanceof NotFoundException) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `retrieving tester with ID: ${id}`,
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
   * Lists testers with optional name filtering and pagination.
   * @param query Query params from GET /testers.
   * @returns Paginated tester response payload.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async listTesters(
    query: SearchTesterQueryDto,
  ): Promise<TesterPaginatedResponseDto> {
    try {
      const { name, page = 1, perPage = 20 } = query;
      const skip = (page - 1) * perPage;
      const where: Prisma.testerWhereInput = {
        ...(name && {
          name: {
            contains: name,
            mode: 'insensitive',
          },
        }),
      };

      const [testers, total] = await Promise.all([
        this.prisma.tester.findMany({
          where,
          skip,
          take: perPage,
          orderBy: {
            name: 'asc',
          },
          select: testerListSelect,
        }),
        this.prisma.tester.count({
          where,
        }),
      ]);

      return {
        metadata: {
          total,
          page,
          perPage,
          totalPages: Math.ceil(total / perPage),
        },
        testers: testers.map((testerData) =>
          this.mapTesterSummaryResponse(testerData),
        ),
      };
    } catch (error) {
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `listing testers with filters: ${JSON.stringify(query)}`,
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
   * Maps Prisma tester records to API response DTOs and converts jar bytes to base64.
   * @param testerData Prisma tester record.
   * @returns Tester response DTO.
   */
  private mapTesterResponse(
    testerData: TesterResponseRecord | TesterResponseWithoutJarRecord,
  ): TesterResponseDto {
    const jarFile =
      'jarFile' in testerData && testerData.jarFile
        ? Buffer.from(testerData.jarFile).toString('base64')
        : null;

    return {
      ...testerData,
      jarFile,
    };
  }

  /**
   * Maps Prisma tester list records to lightweight API response DTOs.
   * @param testerData Prisma tester list record without source or jar bytes.
   * @returns Tester summary response DTO.
   */
  private mapTesterSummaryResponse(
    testerData: TesterListRecord,
  ): TesterSummaryResponseDto {
    return testerData;
  }

  /**
   * Enqueues asynchronous compilation without blocking API response flow.
   * @param testerId Tester identifier to compile.
   * @param sourceCode Source code snapshot for the queued compile job.
   * @returns void
   */
  private triggerCompilation(testerId: string, sourceCode: string): void {
    void this.testerCompilationService
      .enqueueCompilation(testerId, sourceCode)
      .catch((error) => {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        this.logger.error(
          `Failed to enqueue compilation for tester ${testerId}: ${errorMessage}`,
        );
      });
  }
}
