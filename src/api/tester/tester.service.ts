import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { CompilationStatus, Prisma } from '@prisma/client';
import { nanoid } from 'nanoid';
import {
  CreateTesterVersionDto,
  CreateTesterDto,
  SearchTesterQueryDto,
  TesterPaginatedResponseDto,
  TesterResponseDto,
  TesterSummaryResponseDto,
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

const testerVersionSeedSelect = {
  id: true,
  name: true,
  version: true,
  className: true,
  sourceCode: true,
} satisfies Prisma.testerSelect;

/**
 * Compares dotted or dashed tester version strings using numeric-aware segment
 * comparison so `1.0.10` sorts after `1.0.2`.
 * @param left Left-hand version string.
 * @param right Right-hand version string.
 * @returns Negative when left < right, positive when left > right, or 0 when equal.
 */
function compareVersionStrings(left: string, right: string): number {
  const leftParts = left.split(/[.-]/);
  const rightParts = right.split(/[.-]/);
  const maxLength = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] || '0';
    const rightPart = rightParts[index] || '0';
    const leftNumber = Number(leftPart);
    const rightNumber = Number(rightPart);

    if (Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
    } else if (leftPart !== rightPart) {
      return leftPart.localeCompare(rightPart);
    }
  }

  return 0;
}

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
   * Creates a tester record after trimming tester metadata fields that should
   * not preserve surrounding whitespace.
   * @param body Input payload from POST /testers.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Created tester mapped to `TesterResponseDto` with `PENDING` compile state.
   * @throws ConflictException When the tester family name already exists and
   * a new version must be published through PUT /testers/:id instead.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async createTester(
    body: CreateTesterDto,
    user: JwtUser,
  ): Promise<TesterResponseDto> {
    const normalizedBody: CreateTesterDto = {
      ...body,
      name: body.name.trim(),
      version: body.version.trim(),
      className: body.className.trim(),
    };

    try {
      const existingVersions = await this.prisma.tester.findMany({
        where: {
          name: normalizedBody.name,
        },
        select: {
          version: true,
        },
      });

      if (existingVersions.length > 0) {
        const maxExistingVersion = existingVersions.reduce(
          (currentMaxVersion, testerRecord) =>
            compareVersionStrings(testerRecord.version, currentMaxVersion) > 0
              ? testerRecord.version
              : currentMaxVersion,
          existingVersions[0].version,
        );

        throw new ConflictException(
          `Tester ${normalizedBody.name} already exists. Use PUT /testers/:id to publish a version higher than ${maxExistingVersion}.`,
        );
      }

      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const created = await this.prisma.tester.create({
        data: {
          id: nanoid(14),
          ...normalizedBody,
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
      if (error instanceof ConflictException) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `creating tester with name: ${normalizedBody.name}`,
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
   * Creates a new version record for an existing tester family after trimming
   * the submitted version and class-name metadata.
   * @param id Existing tester identifier used to resolve the tester family name.
   * @param body New tester-version payload.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @param includeJarFile When true, includes the compiled jar payload.
   * @returns Created tester-version response DTO plus compile trigger metadata.
   * @throws NotFoundException When the referenced tester does not exist.
   * @throws BadRequestException When the requested version is not higher than the current max version.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async createTesterVersion(
    id: string,
    body: CreateTesterVersionDto,
    user: JwtUser,
    includeJarFile: boolean = false,
  ): Promise<UpdateTesterResult> {
    const normalizedBody: CreateTesterVersionDto = {
      ...body,
      version: body.version.trim(),
      className: body.className.trim(),
    };

    try {
      const existing = await this.prisma.tester.findUnique({
        where: { id },
        select: testerVersionSeedSelect,
      });

      if (!existing) {
        throw new NotFoundException(`Tester with ID ${id} not found.`);
      }

      const existingVersions = await this.prisma.tester.findMany({
        where: {
          name: existing.name,
        },
        select: {
          version: true,
        },
      });
      const maxExistingVersion = existingVersions.reduce(
        (currentMaxVersion, testerRecord) =>
          compareVersionStrings(testerRecord.version, currentMaxVersion) > 0
            ? testerRecord.version
            : currentMaxVersion,
        existing.version,
      );

      if (
        compareVersionStrings(normalizedBody.version, maxExistingVersion) <= 0
      ) {
        throw new BadRequestException(
          `Version must be greater than the current max version ${maxExistingVersion} for tester ${existing.name}.`,
        );
      }

      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const created = await this.prisma.tester.create({
        data: {
          id: nanoid(14),
          name: existing.name,
          version: normalizedBody.version,
          sourceCode: normalizedBody.sourceCode,
          className: normalizedBody.className,
          compilationStatus: CompilationStatus.PENDING,
          compilationError: null,
          jarFile: null,
          createdBy: actor,
          updatedBy: actor,
        },
        select: includeJarFile
          ? testerResponseWithJarSelect
          : testerResponseSelect,
      });

      this.triggerCompilation(created.id, created.sourceCode);

      return {
        tester: this.mapTesterResponse(created),
        compilationTriggered: true,
      };
    } catch (error) {
      if (
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        throw error;
      }
      const errorResponse = this.prismaErrorService.handleError(
        error,
        `creating tester version from tester ID: ${id}`,
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
          orderBy: [{ name: 'asc' }, { createdAt: 'desc' }],
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
