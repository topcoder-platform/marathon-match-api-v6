import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { isAxiosError } from 'axios';
import {
  CompilationStatus,
  PhaseConfigType,
  Prisma,
  phaseConfig,
} from '@prisma/client';
import { nanoid } from 'nanoid';
import { firstValueFrom } from 'rxjs';
import {
  CreateMarathonMatchConfigDto,
  MarathonMatchConfigPaginatedResponseDto,
  MarathonMatchConfigResponseDto,
  MarathonMatchDefaultsResponseDto,
  PhaseConfigDto,
  PhaseConfigResponseDto,
  RerunResponseDto,
  SearchMarathonMatchConfigQueryDto,
  SystemRerunResponseDto,
  TestSubmissionResponseDto,
  TestSubmissionUploadDto,
  UpdateMarathonMatchConfigDto,
} from 'src/dto/marathon-match-config.dto';
import {
  EcsService,
  MarathonMatchScorerTaskLaunchResult,
} from 'src/shared/modules/global/ecs.service';
import { JwtUser } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { M2MService } from 'src/shared/modules/global/m2m.service';
import { PrismaErrorService } from 'src/shared/modules/global/prisma-error.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import {
  ScoringResultService,
  SkippedSystemScoreDispatchResult,
  SystemScoreDispatchResult,
} from '../scoring-result/scoring-result.service';

type MarathonMatchConfigWithPhaseConfigs =
  Prisma.marathonMatchConfigGetPayload<{
    include: {
      phaseConfigs: true;
    };
  }>;

type MarathonMatchPhaseConfigInput = {
  phase: PhaseConfigDto | undefined;
  configType: PhaseConfigType;
};

type NormalizedPhaseConfigInput = {
  phase:
    | (Omit<PhaseConfigDto, 'startSeed'> & {
        startSeed: bigint;
      })
    | undefined;
  configType: PhaseConfigType;
};

type SystemReviewRerunCandidate = {
  reviewId: string;
  submissionId: string;
};

type RerunSubmissionDispatchCandidate = {
  submissionId: string;
  memberId?: string;
  virusScan?: boolean;
};

interface ChallengePhaseResponse {
  id?: string;
  phaseId?: string;
  isOpen?: boolean;
  actualStartDate?: string | number | Date | null;
  scheduledStartDate?: string | number | Date | null;
}

interface ChallengeResponse {
  status?: string;
  currentPhase?: ChallengePhaseResponse;
  phases?: ChallengePhaseResponse[];
  result?: {
    status?: string;
    currentPhase?: ChallengePhaseResponse;
    phases?: ChallengePhaseResponse[];
    content?: {
      status?: string;
      currentPhase?: ChallengePhaseResponse;
      phases?: ChallengePhaseResponse[];
    };
  };
}

/**
 * Handles marathon match configuration CRUD operations, default retrieval,
 * manual rerun dispatching for latest challenge submissions and existing
 * SYSTEM reviews, and tester-change reruns for active challenges.
 * Maps persistence records to API response DTOs for challenge config endpoints.
 */
@Injectable()
export class MarathonMatchConfigService {
  private static readonly maxStartSeed = BigInt('9223372036854775807');
  private static readonly scorerLaunchBatchSize = 8;
  private static readonly scorerLaunchBatchDelayMs = 1100;
  private readonly logger = LoggerService.forRoot('MarathonMatchConfigService');
  private readonly challengeApiBaseUrl =
    process.env.CHALLENGE_API_URL?.replace(/\/+$/, '') ||
    'https://api.topcoder-dev.com';
  private readonly defaultSystemTestTimeout = this.getPositiveIntegerEnv(
    'DEFAULT_SYSTEM_TEST_TIMEOUT_MS',
    86400000,
  );
  private readonly scorecardIdLookupCache = new Map<string, string | null>();

  constructor(
    private readonly httpService: HttpService,
    private readonly ecsService: EcsService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
    private readonly prismaErrorService: PrismaErrorService,
    private readonly scoringResultService: ScoringResultService,
  ) {}

  /**
   * Retrieves configurable default values for new marathon match configs from environment variables.
   * @returns Default review scorecard ID, test timeout, compile timeout, and optional task definition defaults mapped to `MarathonMatchDefaultsResponseDto`.
   * @throws InternalServerErrorException When `DEFAULT_REVIEW_SCORECARD_ID` is not configured.
   */
  getDefaults(): MarathonMatchDefaultsResponseDto {
    const reviewScorecardId = process.env.DEFAULT_REVIEW_SCORECARD_ID?.trim();

    if (!reviewScorecardId) {
      throw new InternalServerErrorException(
        'DEFAULT_REVIEW_SCORECARD_ID is not configured.',
      );
    }

    const parsedTestTimeout = Number.parseInt(
      process.env.DEFAULT_TEST_TIMEOUT_MS ?? '',
      10,
    );
    const testTimeout =
      Number.isFinite(parsedTestTimeout) && parsedTestTimeout > 0
        ? parsedTestTimeout
        : 90000;

    const parsedCompileTimeout = Number.parseInt(
      process.env.DEFAULT_COMPILE_TIMEOUT_MS ?? '',
      10,
    );
    const compileTimeout =
      Number.isFinite(parsedCompileTimeout) && parsedCompileTimeout > 0
        ? parsedCompileTimeout
        : 120000;
    const systemTestTimeout = this.defaultSystemTestTimeout;
    const taskDefinitionName =
      process.env.DEFAULT_TASK_DEFINITION_NAME?.trim() || '';
    const taskDefinitionVersion =
      process.env.DEFAULT_TASK_DEFINITION_VERSION?.trim() || '';

    return {
      reviewScorecardId,
      testTimeout,
      compileTimeout,
      systemTestTimeout,
      taskDefinitionName,
      taskDefinitionVersion,
    };
  }

  /**
   * Creates a marathon match configuration and optional phase configs.
   * @param challengeId Challenge ID from path params in POST /challenge/:challengeId.
   * @param body Input payload from POST /challenge/:challengeId.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Created marathon match config mapped to `MarathonMatchConfigResponseDto`.
   * @throws NotFoundException When the referenced challenge or tester does not exist.
   * @throws ConflictException When a config already exists for the challenge.
   * @throws BadRequestException When `challengeId` is invalid, `reviewScorecardId` cannot be resolved by review-api, phase `startSeed` is outside the supported 64-bit range, or a phase identifier does not exist on the challenge.
   * @throws InternalServerErrorException When the database operation fails.
   */
  async createConfig(
    challengeId: string,
    body: CreateMarathonMatchConfigDto,
    user: JwtUser,
  ): Promise<MarathonMatchConfigResponseDto> {
    try {
      await this.fetchChallengePayload(challengeId);

      const testerData = await this.prisma.tester.findUnique({
        where: { id: body.testerId },
      });

      if (!testerData) {
        throw new NotFoundException(
          `Tester with ID ${body.testerId} not found.`,
        );
      }

      await this.validateReviewScorecardId(body.reviewScorecardId);

      const phaseConfigs: MarathonMatchPhaseConfigInput[] = [
        { phase: body.example, configType: PhaseConfigType.EXAMPLE },
        { phase: body.provisional, configType: PhaseConfigType.PROVISIONAL },
        { phase: body.system, configType: PhaseConfigType.SYSTEM },
      ];
      const phaseConfigsWithBigIntSeeds = this.normalizeStartSeeds(
        challengeId,
        phaseConfigs,
      );
      const normalizedPhaseConfigs = await this.normalizeConfiguredPhaseIds(
        challengeId,
        phaseConfigsWithBigIntSeeds,
      );

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
            systemTestTimeout: body.systemTestTimeout,
            taskDefinitionName: body.taskDefinitionName,
            taskDefinitionVersion: body.taskDefinitionVersion,
            createdBy: actor,
            updatedBy: actor,
          },
        });

        for (const { phase, configType } of normalizedPhaseConfigs) {
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
      if (errorResponse.code === 'UNIQUE_CONSTRAINT_FAILED') {
        throw new ConflictException({
          message: `Marathon match config with challenge ID ${challengeId} already exists.`,
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
   * Updates a marathon match configuration and upserts requested phase configs.
   * When the tester changes and the updated config remains active, it also
   * triggers the existing latest-submission rerun flow so the active challenge is
   * rescored with the new tester.
   * @param challengeId Challenge ID from path params.
   * @param body Partial update payload from PUT /challenge/:challengeId.
   * @param user Authenticated user or machine token payload used for audit fields.
   * @returns Updated marathon match config mapped to `MarathonMatchConfigResponseDto`.
   * @throws NotFoundException When the config or updated tester does not exist.
   * @throws BadRequestException When `reviewScorecardId` cannot be resolved by review-api, phase `startSeed` is outside the supported 64-bit range, a phase identifier does not exist on the challenge, or tester-change rerun validation fails.
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

      const testerChanged = Boolean(
        body.testerId && body.testerId !== existing.testerId,
      );
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

      if (body.reviewScorecardId) {
        await this.validateReviewScorecardId(body.reviewScorecardId);
      }

      const actor = user.isMachine ? 'System' : (user.userId ?? null);
      const { example, provisional, system, ...scalarFields } = body;
      if (scalarFields.reviewScorecardId) {
        scalarFields.reviewScorecardId = scalarFields.reviewScorecardId.trim();
      }
      const phaseConfigs: MarathonMatchPhaseConfigInput[] = [
        { phase: example, configType: PhaseConfigType.EXAMPLE },
        { phase: provisional, configType: PhaseConfigType.PROVISIONAL },
        { phase: system, configType: PhaseConfigType.SYSTEM },
      ];
      const phaseConfigsWithBigIntSeeds = this.normalizeStartSeeds(
        challengeId,
        phaseConfigs,
      );
      const normalizedPhaseConfigs = await this.normalizeConfiguredPhaseIds(
        challengeId,
        phaseConfigsWithBigIntSeeds,
      );

      await this.prisma.$transaction(async (prisma) => {
        await prisma.marathonMatchConfig.update({
          where: { challengeId },
          data: {
            ...scalarFields,
            updatedBy: actor,
          },
        });

        for (const { phase, configType } of normalizedPhaseConfigs) {
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

      const response = this.mapConfigResponse(updatedConfig);
      if (testerChanged && updatedConfig.active) {
        await this.rerunLatestSubmissions(challengeId, user);
      }

      return response;
    } catch (error) {
      if (error instanceof HttpException) {
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
      return await this.mapResolvedConfigResponse(config);
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
   * Reruns scorer tasks for the latest submissions of an active marathon match challenge.
   * Uses the challenge's currently open phase config, validates active/open
   * challenge runtime state through challenge-api, reduces submission API
   * results to one latest submission per member, and launches ECS scorer tasks
   * in bounded batches to avoid RunTask API throttling.
   * @param challengeId Challenge ID from path params in POST /challenge/:challengeId/rerun.
   * @param user Authenticated user or machine token payload for audit-aware logging.
   * @returns Rerun dispatch summary mapped to `RerunResponseDto`.
   * @throws NotFoundException When the marathon match config does not exist.
   * @throws BadRequestException When the config/challenge is inactive, the challenge has no open phase,
   * the tester is not compiled successfully, or no matching open phase config exists.
   * @throws InternalServerErrorException When submission lookup or ECS dispatch fails unexpectedly.
   */
  async rerunLatestSubmissions(
    challengeId: string,
    user: JwtUser,
  ): Promise<RerunResponseDto> {
    try {
      const config = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
        include: {
          phaseConfigs: true,
          tester: true,
        },
      });

      if (!config) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      if (config.active === false) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} is inactive. Rerun is allowed only for ACTIVE Marathon Match challenges.`,
        );
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        const compilationError = config.tester.compilationError?.trim();
        throw new BadRequestException(
          `Tester ${config.testerId} for challenge ${challengeId} is not ready for rerun. Current compilation status: ${config.tester.compilationStatus}.${compilationError ? ` compilationError: ${compilationError}` : ''}`,
        );
      }

      const submissionApiBaseUrl =
        process.env.SUBMISSION_API_URL?.trim() ||
        config.submissionApiUrl?.trim();
      if (!submissionApiBaseUrl) {
        throw new Error(
          `Submission API URL is not configured for challenge ${challengeId}.`,
        );
      }

      const token = await this.m2mService.getM2MToken();
      if (!token) {
        throw new Error(
          'Unable to get M2M token for challenge/submission API calls.',
        );
      }

      const asRecord = (value: unknown): Record<string, unknown> =>
        typeof value === 'object' && value !== null
          ? (value as Record<string, unknown>)
          : {};
      const asString = (value: unknown): string | undefined =>
        typeof value === 'string'
          ? value
          : typeof value === 'number' || typeof value === 'bigint'
            ? String(value)
            : undefined;
      const asBoolean = (value: unknown): boolean | undefined => {
        if (typeof value === 'boolean') {
          return value;
        }

        if (typeof value === 'string') {
          const normalized = value.trim().toLowerCase();
          if (normalized === 'true') {
            return true;
          }

          if (normalized === 'false') {
            return false;
          }
        }

        if (typeof value === 'number') {
          if (value === 1) {
            return true;
          }

          if (value === 0) {
            return false;
          }
        }

        return undefined;
      };
      const parsePositiveInteger = (value: unknown): number | null => {
        if (Array.isArray(value)) {
          for (const entry of value) {
            const parsed = parsePositiveInteger(entry);
            if (parsed !== null) {
              return parsed;
            }
          }

          return null;
        }

        const parsed = Number.parseInt(asString(value) ?? '', 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
      };
      const toTimestamp = (value: unknown): number => {
        if (value instanceof Date) {
          return value.getTime();
        }

        const normalized = asString(value)?.trim();
        if (!normalized) {
          return Number.NEGATIVE_INFINITY;
        }

        const timestamp = new Date(normalized).getTime();
        return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
      };
      const extractSubmissionArray = (
        data: unknown,
      ): Record<string, unknown>[] => {
        if (Array.isArray(data)) {
          return data.map((entry) => asRecord(entry));
        }

        const wrapper = asRecord(data);
        if (Array.isArray(wrapper.result)) {
          return wrapper.result.map((entry) => asRecord(entry));
        }

        const resultRecord = asRecord(wrapper.result);
        if (Array.isArray(resultRecord.content)) {
          return resultRecord.content.map((entry) => asRecord(entry));
        }

        if (Array.isArray(resultRecord.data)) {
          return resultRecord.data.map((entry) => asRecord(entry));
        }

        if (Array.isArray(wrapper.data)) {
          return wrapper.data.map((entry) => asRecord(entry));
        }

        const dataRecord = asRecord(wrapper.data);
        if (Array.isArray(dataRecord.content)) {
          return dataRecord.content.map((entry) => asRecord(entry));
        }

        return [];
      };
      const extractBodyTotalPages = (data: unknown): number | null => {
        const wrapper = asRecord(data);
        const resultRecord = asRecord(wrapper.result);
        const resultContentRecord = asRecord(resultRecord.content);
        const dataRecord = asRecord(wrapper.data);
        const candidates = [
          asRecord(wrapper.meta),
          asRecord(resultRecord.meta),
          asRecord(resultContentRecord.meta),
          asRecord(dataRecord.meta),
          asRecord(wrapper.pagination),
          asRecord(resultRecord.pagination),
          asRecord(resultContentRecord.pagination),
          asRecord(dataRecord.pagination),
          wrapper,
          resultRecord,
          resultContentRecord,
          dataRecord,
        ];

        for (const candidate of candidates) {
          const totalPages = parsePositiveInteger(candidate.totalPages);
          if (totalPages !== null) {
            return totalPages;
          }
        }

        return null;
      };
      const parseTotalPages = (
        data: unknown,
        headers: Record<string, unknown> | undefined,
      ): number => {
        const bodyTotalPages = extractBodyTotalPages(data);
        if (bodyTotalPages !== null) {
          return bodyTotalPages;
        }

        const totalPagesValue =
          headers?.['x-total-pages'] ??
          headers?.['X-Total-Pages'] ??
          headers?.['x-total-page'];
        return parsePositiveInteger(totalPagesValue) ?? 1;
      };
      const resolveChallengePayload = (
        data: unknown,
      ): Record<string, unknown> => {
        const wrapper = asRecord(data);
        const resultRecord = asRecord(wrapper.result);
        const resultContentRecord = asRecord(resultRecord.content);

        if (
          resultContentRecord.status !== undefined ||
          resultContentRecord.currentPhase !== undefined ||
          resultContentRecord.phases !== undefined
        ) {
          return resultContentRecord;
        }

        if (
          resultRecord.status !== undefined ||
          resultRecord.currentPhase !== undefined ||
          resultRecord.phases !== undefined
        ) {
          return resultRecord;
        }

        return wrapper;
      };
      const extractPhaseId = (phase: unknown): string | null => {
        const normalizedPhase = asRecord(phase);
        const phaseId =
          asString(normalizedPhase.phaseId ?? normalizedPhase.id)?.trim() ?? '';
        return phaseId.length > 0 ? phaseId : null;
      };
      const resolveOpenPhaseIds = (phases: unknown): string[] => {
        if (!Array.isArray(phases) || phases.length === 0) {
          return [];
        }

        const openPhases = phases
          .map((phase, index) => ({ phase: asRecord(phase), index }))
          .filter(({ phase }) => asBoolean(phase.isOpen) === true);

        if (openPhases.length === 0) {
          return [];
        }

        return [
          ...new Set(
            openPhases
              .sort((left, right) => {
                const leftStartTimestamp = toTimestamp(
                  left.phase.actualStartDate ?? left.phase.scheduledStartDate,
                );
                const rightStartTimestamp = toTimestamp(
                  right.phase.actualStartDate ?? right.phase.scheduledStartDate,
                );

                if (leftStartTimestamp !== rightStartTimestamp) {
                  return rightStartTimestamp - leftStartTimestamp;
                }

                return right.index - left.index;
              })
              .map(({ phase }) => extractPhaseId(phase))
              .filter((phaseId): phaseId is string => Boolean(phaseId)),
          ),
        ];
      };
      const extractOpenPhaseIds = (data: unknown): string[] => {
        const challengePayload = resolveChallengePayload(data);
        const openPhaseIds = resolveOpenPhaseIds(challengePayload.phases);
        if (openPhaseIds.length > 0) {
          return openPhaseIds;
        }

        const currentPhase = asRecord(challengePayload.currentPhase);
        if (asBoolean(currentPhase.isOpen) !== true) {
          return [];
        }

        const currentPhaseId = extractPhaseId(currentPhase);
        return currentPhaseId ? [currentPhaseId] : [];
      };
      const findPhaseConfigForOpenPhase = (openPhaseIds: string[]) => {
        for (const openPhaseId of openPhaseIds) {
          const openPhaseConfig = config.phaseConfigs.find(
            (phaseConfigData) => phaseConfigData.phaseId.trim() === openPhaseId,
          );
          if (openPhaseConfig) {
            return openPhaseConfig;
          }
        }

        return null;
      };
      type RerunSubmissionCandidate = {
        submissionId: string;
        memberId: string;
        submittedDate: string;
        receivedOrSubmittedDate: string;
        sortTimestamp: number;
        isLatest?: boolean;
        virusScan?: boolean;
        sequence: number;
      };
      const normalizeSubmission = (
        submission: Record<string, unknown>,
        sequence: number,
      ): RerunSubmissionCandidate | null => {
        const submissionId =
          asString(submission.submissionId)?.trim() ||
          asString(submission.id)?.trim() ||
          '';
        const memberId = asString(submission.memberId)?.trim() || '';
        if (!submissionId || !memberId) {
          return null;
        }

        const receivedOrSubmittedDate =
          asString(submission.submittedDate)?.trim() ||
          asString(submission.receivedDate)?.trim() ||
          asString(submission.receivedAt)?.trim() ||
          asString(submission.createdAt)?.trim() ||
          asString(submission.updatedAt)?.trim() ||
          '';

        return {
          submissionId,
          memberId,
          submittedDate:
            asString(submission.submittedDate)?.trim() ||
            receivedOrSubmittedDate,
          receivedOrSubmittedDate,
          sortTimestamp: toTimestamp(receivedOrSubmittedDate),
          isLatest: Object.prototype.hasOwnProperty.call(submission, 'isLatest')
            ? asBoolean(submission.isLatest)
            : undefined,
          virusScan: asBoolean(submission.virusScan),
          sequence,
        };
      };
      const isCandidateNewer = (
        left: RerunSubmissionCandidate,
        right: RerunSubmissionCandidate,
      ): boolean => {
        if (left.sortTimestamp !== right.sortTimestamp) {
          return left.sortTimestamp > right.sortTimestamp;
        }

        if (left.receivedOrSubmittedDate !== right.receivedOrSubmittedDate) {
          return left.receivedOrSubmittedDate > right.receivedOrSubmittedDate;
        }

        return left.sequence > right.sequence;
      };

      const submissionCandidates: RerunSubmissionCandidate[] = [];
      let submissionSequence = 0;
      let page = 1;
      let totalPages = 1;

      const challengeResponse = await firstValueFrom(
        this.httpService.get<ChallengeResponse>(
          `${this.challengeApiBaseUrl}/v6/challenges/${challengeId}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        ),
      );
      const challengePayload = resolveChallengePayload(challengeResponse.data);
      const challengeStatus =
        asString(challengePayload.status)?.trim().toUpperCase() ?? 'UNKNOWN';
      if (challengeStatus !== 'ACTIVE') {
        throw new BadRequestException(
          `Challenge ${challengeId} is not active. Current challenge status: ${asString(challengePayload.status)?.trim() || 'UNKNOWN'}.`,
        );
      }

      const openPhaseIds = extractOpenPhaseIds(challengeResponse.data);
      if (openPhaseIds.length === 0) {
        throw new BadRequestException(
          `Challenge ${challengeId} has no open phase. Rerun is allowed only for ACTIVE Marathon Match challenges.`,
        );
      }

      const openPhaseConfig = findPhaseConfigForOpenPhase(openPhaseIds);
      if (!openPhaseConfig) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} has no phase config for currently open challenge phase ${openPhaseIds.join(', ')}.`,
        );
      }

      do {
        const response = await firstValueFrom(
          this.httpService.get(
            `${submissionApiBaseUrl.replace(/\/+$/, '')}/submissions`,
            {
              headers: {
                Authorization: `Bearer ${token}`,
              },
              params: {
                challengeId,
                isLatest: true,
                perPage: 100,
                page,
              },
            },
          ),
        );

        submissionCandidates.push(
          ...extractSubmissionArray(response.data)
            .map((submission) =>
              normalizeSubmission(submission, submissionSequence++),
            )
            .filter(
              (submission): submission is RerunSubmissionCandidate =>
                submission !== null,
            ),
        );

        totalPages = parseTotalPages(
          response.data,
          response.headers as Record<string, unknown> | undefined,
        );
        page += 1;
      } while (page <= totalPages);

      const latestByMember = new Map<string, RerunSubmissionCandidate>();
      const flaggedLatestByMember = new Map<string, RerunSubmissionCandidate>();
      for (const candidate of submissionCandidates) {
        const currentLatest = latestByMember.get(candidate.memberId);
        if (!currentLatest || isCandidateNewer(candidate, currentLatest)) {
          latestByMember.set(candidate.memberId, candidate);
        }

        if (candidate.isLatest === true) {
          const currentFlaggedLatest = flaggedLatestByMember.get(
            candidate.memberId,
          );
          if (
            !currentFlaggedLatest ||
            isCandidateNewer(candidate, currentFlaggedLatest)
          ) {
            flaggedLatestByMember.set(candidate.memberId, candidate);
          }
        }
      }

      const submissions = Array.from(latestByMember.entries())
        .map(([memberId, fallbackLatest]) => {
          return flaggedLatestByMember.get(memberId) ?? fallbackLatest;
        })
        .sort((left, right) => {
          if (left.sortTimestamp !== right.sortTimestamp) {
            return left.sortTimestamp - right.sortTimestamp;
          }

          if (left.receivedOrSubmittedDate !== right.receivedOrSubmittedDate) {
            return left.receivedOrSubmittedDate.localeCompare(
              right.receivedOrSubmittedDate,
            );
          }

          return left.sequence - right.sequence;
        })
        .map((submission) => ({
          submissionId: submission.submissionId,
          memberId: submission.memberId,
          submittedDate: submission.submittedDate,
          virusScan: submission.virusScan,
        }));

      if (submissions.length === 0) {
        this.logger.log({
          message: 'No latest submissions found for marathon match rerun.',
          challengeId,
          actor: this.getActor(user),
        });

        return {
          challengeId,
          submissionsQueued: 0,
          results: [],
        };
      }

      const launchResults = await this.launchScorerTasksWithRateLimit(
        challengeId,
        submissions,
        {
          taskDefinitionName: config.taskDefinitionName,
          taskDefinitionVersion: config.taskDefinitionVersion,
        },
        {
          configType: openPhaseConfig.configType,
          startSeed: openPhaseConfig.startSeed,
          numberOfTests: openPhaseConfig.numberOfTests,
          scorecardId: config.reviewScorecardId,
        },
      );

      const results: RerunResponseDto['results'] = submissions.map(
        ({ submissionId }, index) => {
          const launchResult = launchResults[index];
          if (launchResult.status === 'fulfilled') {
            return {
              submissionId,
              taskArn: launchResult.value.taskArn,
              taskId: launchResult.value.taskId,
            };
          }

          const reason = launchResult.reason;
          return {
            submissionId,
            error: reason instanceof Error ? reason.message : String(reason),
          };
        },
      );

      this.logger.log({
        message: 'Marathon match rerun dispatch completed.',
        challengeId,
        actor: this.getActor(user),
        submissionsQueued: submissions.length,
        launchedCount: results.filter((result) => !!result.taskId).length,
        failedCount: results.filter((result) => !!result.error).length,
      });

      return {
        challengeId,
        submissionsQueued: submissions.length,
        results,
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
        `rerunning latest marathon match submissions with challenge ID: ${challengeId} for actor: ${this.getActor(user)}`,
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
   * Restarts SYSTEM scorer tasks for existing system review records on an active
   * Marathon Match challenge. The method finds non-cancelled review-api reviews
   * that use the challenge's configured review scorecard, then dispatches each
   * through the SYSTEM scoring path so review IDs and timeout guards are
   * preserved.
   * @param challengeId Challenge ID from path params in POST /challenge/:challengeId/rerun/system.
   * @param user Authenticated user or machine token payload for audit-aware logging.
   * @returns SYSTEM rerun dispatch summary mapped to `SystemRerunResponseDto`.
   * @throws NotFoundException When the marathon match config does not exist.
   * @throws BadRequestException When the config/challenge is inactive, the tester is not compiled
   * successfully, or SYSTEM phase config is missing.
   * @throws InternalServerErrorException When review lookup or SYSTEM dispatch fails unexpectedly.
   */
  async rerunSystemTests(
    challengeId: string,
    user: JwtUser,
  ): Promise<SystemRerunResponseDto> {
    try {
      const config = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
        include: {
          phaseConfigs: true,
          tester: true,
        },
      });

      if (!config) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      if (config.active === false) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} is inactive. SYSTEM rerun is allowed only for ACTIVE Marathon Match configurations.`,
        );
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        const compilationError = config.tester.compilationError?.trim();
        throw new BadRequestException(
          `Tester ${config.testerId} for challenge ${challengeId} is not ready for SYSTEM rerun. Current compilation status: ${config.tester.compilationStatus}.${compilationError ? ` compilationError: ${compilationError}` : ''}`,
        );
      }

      if (
        !config.phaseConfigs.some(
          (phaseConfigData) =>
            phaseConfigData.configType === PhaseConfigType.SYSTEM,
        )
      ) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} requires a SYSTEM phase config for SYSTEM rerun dispatch.`,
        );
      }

      const challengePayload = await this.fetchChallengePayload(challengeId);
      const challengeStatus =
        this.asString(challengePayload.status)?.trim().toUpperCase() ??
        'UNKNOWN';
      if (challengeStatus !== 'ACTIVE') {
        throw new BadRequestException(
          `Challenge ${challengeId} is not active. Current challenge status: ${this.asString(challengePayload.status)?.trim() || 'UNKNOWN'}.`,
        );
      }

      const token = await this.m2mService.getM2MToken();
      if (!token) {
        throw new Error('Unable to get M2M token for review API calls.');
      }

      const configuredScorecardIds = await this.getConfiguredReviewScorecardIds(
        config.reviewScorecardId,
      );
      const systemReviews = await this.fetchSystemReviewsForRerun(
        token,
        challengeId,
        configuredScorecardIds,
      );

      if (systemReviews.length === 0) {
        this.logger.log({
          message:
            'No existing SYSTEM reviews found for marathon match SYSTEM rerun.',
          challengeId,
          actor: this.getActor(user),
        });

        return {
          challengeId,
          reviewsQueued: 0,
          results: [],
        };
      }

      const launchResults = await this.triggerSystemReviewsWithRateLimit(
        challengeId,
        systemReviews,
      );
      const results: SystemRerunResponseDto['results'] = systemReviews.map(
        ({ reviewId, submissionId }, index) => {
          const launchResult = launchResults[index];
          if (launchResult.status === 'fulfilled') {
            if (this.isSkippedSystemScoreDispatchResult(launchResult.value)) {
              return {
                reviewId,
                submissionId,
                error: launchResult.value.reason,
              };
            }

            return {
              reviewId,
              submissionId,
              taskArn: launchResult.value.taskArn,
              taskId: launchResult.value.taskId,
            };
          }

          const reason = launchResult.reason;
          return {
            reviewId,
            submissionId,
            error: reason instanceof Error ? reason.message : String(reason),
          };
        },
      );

      this.logger.log({
        message: 'Marathon match SYSTEM rerun dispatch completed.',
        challengeId,
        actor: this.getActor(user),
        reviewsQueued: systemReviews.length,
        launchedCount: results.filter((result) => !!result.taskId).length,
        failedCount: results.filter((result) => !!result.error).length,
      });

      return {
        challengeId,
        reviewsQueued: systemReviews.length,
        results,
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
        `rerunning marathon match SYSTEM tests with challenge ID: ${challengeId} for actor: ${this.getActor(user)}`,
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
   * Creates a clean Review API validation submission and queues one scorer ECS task.
   * @param challengeId Challenge ID from POST /challenge/:challengeId/test-submission.
   * @param body Multipart fields selecting the phase config and optional member/file overrides.
   * @param file Uploaded submission archive captured by Nest memory storage.
   * @param user Authenticated caller used as the fallback member id and audit context.
   * @returns Validation submission id and ECS task launch details.
   * @throws NotFoundException When the Marathon Match config does not exist.
   * @throws BadRequestException When file contents are missing, the tester is not compiled, or the phase config is missing.
   * @throws HttpException When Review API rejects the validation upload.
   * @throws InternalServerErrorException When ECS launch fails unexpectedly.
   * Used by challenge managers and copilots to validate scorer behavior before launch.
   */
  async uploadTestSubmission(
    challengeId: string,
    body: TestSubmissionUploadDto,
    file: Express.Multer.File,
    user: JwtUser,
  ): Promise<TestSubmissionResponseDto> {
    try {
      const hasUploadedFile =
        !!file &&
        ((typeof file.size === 'number' && file.size > 0) ||
          (file.buffer && file.buffer.length > 0));

      if (!hasUploadedFile) {
        throw new BadRequestException(
          'File contents are required for validation submission upload.',
        );
      }

      const config = await this.prisma.marathonMatchConfig.findUnique({
        where: { challengeId },
        include: {
          phaseConfigs: true,
          tester: true,
        },
      });

      if (!config) {
        throw new NotFoundException(
          `Marathon match config with challenge ID ${challengeId} not found.`,
        );
      }

      if (config.tester.compilationStatus !== CompilationStatus.SUCCESS) {
        const compilationError = config.tester.compilationError?.trim();
        throw new BadRequestException(
          `Tester ${config.testerId} for challenge ${challengeId} is not ready for validation scoring. Current compilation status: ${config.tester.compilationStatus}.${compilationError ? ` compilationError: ${compilationError}` : ''}`,
        );
      }

      const configType = body.configType ?? PhaseConfigType.PROVISIONAL;
      const phaseConfigData = config.phaseConfigs.find(
        (phaseConfigEntry) => phaseConfigEntry.configType === configType,
      );
      if (!phaseConfigData) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} requires a ${configType} phase config for validation submission scoring.`,
        );
      }

      const memberId =
        body.memberId?.trim() || this.asString(user.userId)?.trim();
      if (!memberId) {
        throw new BadRequestException(
          'Member ID is required for validation submission upload.',
        );
      }

      const submissionApiBaseUrl =
        process.env.SUBMISSION_API_URL?.trim() ||
        config.submissionApiUrl?.trim();
      if (!submissionApiBaseUrl) {
        throw new Error(
          `Submission API URL is not configured for challenge ${challengeId}.`,
        );
      }

      const token = await this.m2mService.getM2MToken();
      if (!token) {
        throw new Error(
          'Unable to get M2M token for validation submission upload.',
        );
      }

      const submissionId = await this.createValidationSubmission(
        token,
        submissionApiBaseUrl,
        challengeId,
        memberId,
        phaseConfigData.phaseId,
        body.fileName,
        file,
      );
      const launchResult = await this.ecsService.launchScorerTask(
        challengeId,
        submissionId,
        {
          taskDefinitionName: config.taskDefinitionName,
          taskDefinitionVersion: config.taskDefinitionVersion,
        },
        {
          configType: phaseConfigData.configType,
          startSeed: phaseConfigData.startSeed,
          numberOfTests: phaseConfigData.numberOfTests,
        },
        undefined,
        {
          memberId,
        },
      );

      this.logger.log({
        message: 'Marathon Match validation submission queued for scoring.',
        challengeId,
        submissionId,
        memberId,
        configType: phaseConfigData.configType,
        taskId: launchResult.taskId,
        actor: this.getActor(user),
      });

      return {
        challengeId,
        submissionId,
        configType: phaseConfigData.configType,
        taskArn: launchResult.taskArn,
        taskId: launchResult.taskId,
        cloudWatchLogsConsoleUrl: launchResult.cloudWatchLogsConsoleUrl,
      };
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }

      const errorResponse = this.prismaErrorService.handleError(
        error,
        `uploading marathon match validation submission with challenge ID: ${challengeId} for actor: ${this.getActor(user)}`,
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
   * Uploads a validation submission to Review API and extracts the created submission id.
   * @param token M2M bearer token for Review API.
   * @param submissionApiBaseUrl Review API base URL from configuration.
   * @param challengeId Challenge that owns the validation submission.
   * @param memberId Member id used as the submission owner for runner metadata.
   * @param phaseId Configured challenge phase id to persist on the validation submission when present.
   * @param fileName Optional file name override from the multipart request.
   * @param file Uploaded submission archive.
   * @returns Created Review API submission id.
   * @throws BadRequestException When file bytes are unavailable or Review API omits an id.
   * @throws HttpException When Review API rejects the validation upload request.
   * Used by `uploadTestSubmission` before scorer ECS dispatch.
   */
  private async createValidationSubmission(
    token: string,
    submissionApiBaseUrl: string,
    challengeId: string,
    memberId: string,
    phaseId: string | undefined,
    fileName: string | undefined,
    file: Express.Multer.File,
  ): Promise<string> {
    if (!file.buffer || file.buffer.length === 0) {
      throw new BadRequestException(
        'File buffer is required for validation submission upload.',
      );
    }

    const resolvedFileName =
      fileName?.trim() ||
      file.originalname ||
      file.filename ||
      'submission.zip';
    const form = new FormData();

    form.set('challengeId', challengeId);
    form.set('memberId', memberId);
    form.set('type', 'CONTEST_SUBMISSION');
    form.set('fileName', resolvedFileName);
    if (phaseId?.trim()) {
      form.set('submissionPhaseId', phaseId.trim());
    }
    const fileArrayBuffer = new ArrayBuffer(file.buffer.byteLength);
    new Uint8Array(fileArrayBuffer).set(file.buffer);
    form.set(
      'file',
      new Blob([fileArrayBuffer], {
        type: file.mimetype || 'application/octet-stream',
      }),
      resolvedFileName,
    );

    let responseData: unknown;
    try {
      const response = await firstValueFrom(
        this.httpService.post(
          `${submissionApiBaseUrl.replace(/\/+$/, '')}/submissions/validation-upload`,
          form,
          {
            headers: {
              Authorization: `Bearer ${token}`,
            },
          },
        ),
      );
      responseData = response.data;
    } catch (error) {
      const uploadException = this.createValidationUploadException(
        error,
        challengeId,
        memberId,
      );
      if (uploadException) {
        this.logger.error(uploadException.getResponse());
        throw uploadException;
      }

      throw error;
    }

    const submissionId = this.extractCreatedSubmissionId(responseData);
    if (!submissionId) {
      throw new BadRequestException(
        'Validation submission upload did not return a submission id.',
      );
    }

    return submissionId;
  }

  /**
   * Converts Review API validation-upload HTTP failures into API exceptions
   * that preserve the upstream status and enough context to fix auth/config issues.
   * @param error Candidate error thrown by the outbound Review API request.
   * @param challengeId Challenge ID submitted to Review API.
   * @param memberId Member ID submitted to Review API.
   * @returns HttpException for upstream Axios HTTP responses, otherwise undefined.
   * @throws Nothing directly; callers throw the returned exception.
   * Used by `createValidationSubmission` so Review API rejections do not get
   * reported as Prisma errors or generic unknown failures.
   */
  private createValidationUploadException(
    error: unknown,
    challengeId: string,
    memberId: string,
  ): HttpException | undefined {
    if (!isAxiosError(error) || !error.response) {
      return undefined;
    }

    const upstreamStatusCode =
      typeof error.response.status === 'number' && error.response.status > 0
        ? error.response.status
        : HttpStatus.BAD_GATEWAY;
    const upstreamBody = this.asRecord(error.response.data);
    const upstreamError = this.asRecord(upstreamBody.error);
    const upstreamResult = this.asRecord(upstreamBody.result);
    const upstreamCode =
      this.asString(upstreamBody.code)?.trim() ||
      this.asString(upstreamError.code)?.trim() ||
      this.asString(upstreamResult.code)?.trim();
    const upstreamMessage = this.extractUpstreamErrorMessage(
      error.response.data,
      error.message,
    );
    const forbiddenStatusCode = 403;
    const statusLabel =
      upstreamStatusCode === forbiddenStatusCode
        ? '403 Forbidden'
        : `status ${upstreamStatusCode}`;
    const permissionHint =
      upstreamStatusCode === forbiddenStatusCode
        ? ' Confirm the Marathon Match M2M credentials are authorized for create:submission in Review API.'
        : '';
    const message = [
      `Review API rejected the validation submission upload with ${statusLabel}.${permissionHint}`,
      upstreamMessage ? `Upstream message: ${upstreamMessage}` : undefined,
    ]
      .filter(Boolean)
      .join(' ');

    return new HttpException(
      {
        message,
        code: 'VALIDATION_SUBMISSION_UPLOAD_REJECTED',
        details: {
          challengeId,
          memberId,
          upstreamCode,
          upstreamMessage,
          upstreamStatusCode,
        },
      },
      upstreamStatusCode,
    );
  }

  /**
   * Extracts a concise message from common downstream API error wrappers.
   * @param data Raw upstream response body.
   * @param fallback Fallback message from the transport error.
   * @returns First non-empty message found in the response body or fallback.
   * Used when converting Review API upload failures into user-facing exceptions.
   */
  private extractUpstreamErrorMessage(
    data: unknown,
    fallback?: string,
  ): string | undefined {
    const wrapper = this.asRecord(data);
    const errorRecord = this.asRecord(wrapper.error);
    const resultRecord = this.asRecord(wrapper.result);
    const candidates = [
      wrapper.message,
      errorRecord.message,
      resultRecord.message,
      data,
      fallback,
    ];

    for (const candidate of candidates) {
      const message = Array.isArray(candidate)
        ? candidate
            .map((entry) => this.asString(entry)?.trim())
            .filter(Boolean)
            .join('; ')
        : this.asString(candidate)?.trim();

      if (message) {
        return message;
      }
    }

    return undefined;
  }

  /**
   * Extracts a created submission id from common Review API response wrappers.
   * @param data Raw Review API response body.
   * @returns Created submission id, or undefined when no supported field exists.
   * Used after validation upload because environments return direct or wrapped DTOs.
   */
  private extractCreatedSubmissionId(data: unknown): string | undefined {
    const wrapper = this.asRecord(data);
    const resultRecord = this.asRecord(wrapper.result);
    const dataRecord = this.asRecord(wrapper.data);

    return (
      this.asString(wrapper.id)?.trim() ||
      this.asString(resultRecord.id)?.trim() ||
      this.asString(dataRecord.id)?.trim()
    );
  }

  /**
   * Resolves the configured review scorecard to all accepted identifiers that
   * may be present on review-api review records.
   * @param reviewScorecardId Stored config scorecard identifier.
   * @returns Set containing the stored ID and, when resolvable, the canonical review-api ID.
   */
  private async getConfiguredReviewScorecardIds(
    reviewScorecardId: string,
  ): Promise<Set<string>> {
    const scorecardIds = new Set<string>();
    const configuredScorecardId = reviewScorecardId.trim();
    if (configuredScorecardId) {
      scorecardIds.add(configuredScorecardId);
    }

    const resolvedScorecardId = await this.resolveReviewScorecardId(
      configuredScorecardId,
    );
    if (resolvedScorecardId) {
      scorecardIds.add(resolvedScorecardId);
    }

    return scorecardIds;
  }

  /**
   * Loads review-api review records for a challenge and filters them down to
   * non-cancelled SYSTEM review candidates matching the configured scorecard.
   * @param token M2M bearer token for review-api.
   * @param challengeId Challenge ID whose system reviews should be restarted.
   * @param configuredScorecardIds Scorecard IDs accepted for SYSTEM review matching.
   * @returns Review/submission pairs ready for SYSTEM scorer dispatch.
   */
  private async fetchSystemReviewsForRerun(
    token: string,
    challengeId: string,
    configuredScorecardIds: Set<string>,
  ): Promise<SystemReviewRerunCandidate[]> {
    const reviews: SystemReviewRerunCandidate[] = [];
    const seenReviewIds = new Set<string>();
    const url = `${this.buildReviewApiBaseUrl()}/reviews`;
    let page = 1;
    let totalPages = 1;

    do {
      const response = await firstValueFrom(
        this.httpService.get(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
          params: {
            challengeId,
            page,
            perPage: 100,
            thin: 'true',
          },
        }),
      );

      for (const review of this.extractReviewArray(response.data)) {
        const candidate = this.getSystemReviewRerunCandidate(
          review,
          configuredScorecardIds,
        );
        if (!candidate || seenReviewIds.has(candidate.reviewId)) {
          continue;
        }

        seenReviewIds.add(candidate.reviewId);
        reviews.push(candidate);
      }

      totalPages = this.parseTotalPages(
        response.data,
        response.headers as Record<string, unknown> | undefined,
      );
      page += 1;
    } while (page <= totalPages);

    return reviews.sort((left, right) =>
      left.submissionId === right.submissionId
        ? left.reviewId.localeCompare(right.reviewId)
        : left.submissionId.localeCompare(right.submissionId),
    );
  }

  /**
   * Converts one review-api record into a SYSTEM rerun candidate when it matches
   * the configured scorecard and has enough identity data to dispatch scoring.
   * @param review Review object returned by review-api.
   * @param configuredScorecardIds Scorecard IDs accepted for SYSTEM review matching.
   * @returns Candidate review/submission IDs, or undefined when the review should not rerun.
   */
  private getSystemReviewRerunCandidate(
    review: Record<string, unknown>,
    configuredScorecardIds: Set<string>,
  ): SystemReviewRerunCandidate | undefined {
    const reviewId = this.asString(review.id)?.trim();
    const submissionId = this.asString(review.submissionId)?.trim();
    if (!reviewId || !submissionId) {
      return undefined;
    }

    const normalizedStatus = this.asString(review.status)?.trim().toUpperCase();
    if (normalizedStatus === 'CANCELLED' || normalizedStatus === 'DELETED') {
      return undefined;
    }

    const reviewScorecardId =
      this.asString(review.scorecardId)?.trim() ||
      this.asString(review.scoreCardId)?.trim();
    if (!reviewScorecardId || !configuredScorecardIds.has(reviewScorecardId)) {
      return undefined;
    }

    return {
      reviewId,
      submissionId,
    };
  }

  /**
   * Dispatches SYSTEM scoring reruns in small batches so ECS RunTask requests
   * remain below service throttling limits.
   * @param challengeId Challenge ID passed to each SYSTEM dispatch.
   * @param reviews Existing review/submission pairs selected for rerun.
   * @returns Settled dispatch results in the same order as `reviews`.
   */
  private async triggerSystemReviewsWithRateLimit(
    challengeId: string,
    reviews: SystemReviewRerunCandidate[],
  ): Promise<PromiseSettledResult<SystemScoreDispatchResult>[]> {
    const launchResults: PromiseSettledResult<SystemScoreDispatchResult>[] = [];

    for (
      let index = 0;
      index < reviews.length;
      index += MarathonMatchConfigService.scorerLaunchBatchSize
    ) {
      const batch = reviews.slice(
        index,
        index + MarathonMatchConfigService.scorerLaunchBatchSize,
      );
      const batchResults = await Promise.allSettled(
        batch.map(({ reviewId, submissionId }) =>
          this.scoringResultService.triggerSystemScore(
            reviewId,
            submissionId,
            challengeId,
          ),
        ),
      );

      launchResults.push(...batchResults);

      if (
        index + MarathonMatchConfigService.scorerLaunchBatchSize <
        reviews.length
      ) {
        await this.delay(MarathonMatchConfigService.scorerLaunchBatchDelayMs);
      }
    }

    return launchResults;
  }

  /**
   * Checks whether a SYSTEM dispatch result was skipped before ECS launch.
   * @param result SYSTEM dispatch result returned by ScoringResultService.
   * @returns True when the result represents a skipped scoring marker.
   */
  private isSkippedSystemScoreDispatchResult(
    result: SystemScoreDispatchResult,
  ): result is SkippedSystemScoreDispatchResult {
    return 'skipped' in result && result.skipped === true;
  }

  /**
   * Launches rerun scorer tasks in small batches so ECS RunTask requests remain below service throttling limits.
   * @param challengeId Challenge ID passed to each scorer task.
   * @param submissions Latest submissions to rerun, in response order.
   * @param mmConfig Task definition name and version from the marathon match config.
   * @param scoringPhase Phase settings passed to scorer tasks plus scorecard context for skipped markers.
   * @returns Settled launch results in the same order as `submissions`.
   * @throws Does not throw for individual scorer launch failures; those are returned as rejected settled results.
   */
  private async launchScorerTasksWithRateLimit(
    challengeId: string,
    submissions: RerunSubmissionDispatchCandidate[],
    mmConfig: {
      taskDefinitionName: string;
      taskDefinitionVersion: string;
    },
    scoringPhase: {
      configType: PhaseConfigType;
      startSeed: bigint;
      numberOfTests: number;
      scorecardId?: string | null;
    },
  ): Promise<PromiseSettledResult<MarathonMatchScorerTaskLaunchResult>[]> {
    const launchResults: PromiseSettledResult<MarathonMatchScorerTaskLaunchResult>[] =
      [];

    for (
      let index = 0;
      index < submissions.length;
      index += MarathonMatchConfigService.scorerLaunchBatchSize
    ) {
      const batch = submissions.slice(
        index,
        index + MarathonMatchConfigService.scorerLaunchBatchSize,
      );
      const batchResults = await Promise.allSettled(
        batch.map(async ({ submissionId, memberId, virusScan }) => {
          if (virusScan !== true) {
            const reason = `Marathon Match ${scoringPhase.configType} scoring skipped because the submission has not passed virus scanning.`;
            await this.scoringResultService.markSubmissionScoringSkipped({
              challengeId,
              details: {
                virusScan: virusScan ?? null,
              },
              reason,
              scorecardId: scoringPhase.scorecardId ?? undefined,
              submissionId,
              testPhase: scoringPhase.configType,
            });
            throw new Error(reason);
          }

          return this.ecsService.launchScorerTask(
            challengeId,
            submissionId,
            mmConfig,
            scoringPhase,
            undefined,
            { memberId },
          );
        }),
      );

      launchResults.push(...batchResults);

      if (
        index + MarathonMatchConfigService.scorerLaunchBatchSize <
        submissions.length
      ) {
        await this.delay(MarathonMatchConfigService.scorerLaunchBatchDelayMs);
      }
    }

    return launchResults;
  }

  /**
   * Waits for the requested number of milliseconds before resolving.
   * @param delayMs Delay duration in milliseconds.
   * @returns A promise that resolves after `delayMs`.
   */
  private async delay(delayMs: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
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
   * Maps a config record and resolves scorecard identifiers that may still use legacy ids.
   * @param config Prisma config record with related phase configs.
   * @returns API DTO with a canonical review-api scorecard id when lookup succeeds.
   */
  private async mapResolvedConfigResponse(
    config: MarathonMatchConfigWithPhaseConfigs,
  ): Promise<MarathonMatchConfigResponseDto> {
    const response = this.mapConfigResponse(config);
    const resolvedScorecardId = await this.resolveReviewScorecardId(
      response.reviewScorecardId,
    );

    if (resolvedScorecardId) {
      response.reviewScorecardId = resolvedScorecardId;
    }

    return response;
  }

  /**
   * Resolves submitted challenge phase identifiers to canonical challenge-api `phaseId` values.
   * Accepts either `phases[].phaseId` or the challenge-phase instance `phases[].id` for backwards compatibility.
   * @param challengeId Challenge ID whose phases define the allowed identifiers.
   * @param phaseConfigs Candidate phase configs from create/update input.
   * @returns Phase configs with canonical `phaseId` values ready for persistence.
   * @throws BadRequestException When any submitted phase identifier does not exist on the challenge.
   */
  private async normalizeConfiguredPhaseIds(
    challengeId: string,
    phaseConfigs: NormalizedPhaseConfigInput[],
  ): Promise<NormalizedPhaseConfigInput[]> {
    const configuredPhaseIds = phaseConfigs
      .map(({ phase }) => phase?.phaseId?.trim() ?? '')
      .filter((phaseId): phaseId is string => phaseId.length > 0);
    if (configuredPhaseIds.length === 0) {
      return phaseConfigs;
    }

    const canonicalPhaseIdByIdentifier =
      await this.fetchCanonicalPhaseIdByIdentifier(challengeId);

    return phaseConfigs.map(({ phase, configType }) => {
      if (!phase) {
        return { phase, configType };
      }

      const normalizedInputPhaseId = phase.phaseId.trim();
      const canonicalPhaseId = canonicalPhaseIdByIdentifier.get(
        normalizedInputPhaseId,
      );
      if (!canonicalPhaseId) {
        throw new BadRequestException(
          `Phase ID ${normalizedInputPhaseId} is not configured on challenge ${challengeId}. Use challenge-api phases[].phaseId values.`,
        );
      }

      return {
        configType,
        phase: {
          ...phase,
          phaseId: canonicalPhaseId,
        },
      };
    });
  }

  /**
   * Builds a lookup from accepted challenge phase identifiers to canonical persisted phase IDs.
   * @param challengeId Challenge ID to fetch from challenge-api.
   * @returns Map keyed by challenge `phaseId` and legacy challenge-phase `id`, both pointing to canonical `phaseId`.
   * @throws BadRequestException When `challengeId` is invalid.
   * @throws NotFoundException When the challenge does not exist.
   * @throws InternalServerErrorException When challenge validation dependencies are unavailable.
   */
  private async fetchCanonicalPhaseIdByIdentifier(
    challengeId: string,
  ): Promise<Map<string, string>> {
    const challengePayload = await this.fetchChallengePayload(challengeId);
    const challengePhases = this.resolveChallengePhases(challengePayload);
    const canonicalPhaseIdByIdentifier = new Map<string, string>();

    for (const phase of challengePhases) {
      const canonicalPhaseId = this.extractCanonicalChallengePhaseId(phase);
      if (!canonicalPhaseId) {
        continue;
      }

      for (const identifier of this.extractChallengePhaseIdentifiers(phase)) {
        canonicalPhaseIdByIdentifier.set(identifier, canonicalPhaseId);
      }
    }

    return canonicalPhaseIdByIdentifier;
  }

  /**
   * Loads and validates a challenge from challenge-api for config create/update flows.
   * @param challengeId Challenge identifier from the route path.
   * @returns Normalized challenge payload from challenge-api.
   * @throws BadRequestException When `challengeId` is invalid.
   * @throws NotFoundException When the challenge does not exist.
   * @throws InternalServerErrorException When challenge-api or token retrieval is unavailable.
   */
  private async fetchChallengePayload(
    challengeId: string,
  ): Promise<ChallengeResponse> {
    let token: string;
    try {
      token = await this.m2mService.getM2MToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({
        message:
          'Unable to validate Marathon Match challenge id because M2M token retrieval failed.',
        challengeId,
        error: message,
      });
      throw new InternalServerErrorException(
        'Unable to validate challengeId at this time.',
      );
    }

    if (!token) {
      this.logger.warn({
        message:
          'Unable to validate Marathon Match challenge id because M2M token retrieval returned an empty token.',
        challengeId,
      });
      throw new InternalServerErrorException(
        'Unable to validate challengeId at this time.',
      );
    }

    const url = `${this.challengeApiBaseUrl}/v6/challenges/${encodeURIComponent(challengeId)}`;

    try {
      const challengeResponse = await firstValueFrom(
        this.httpService.get<ChallengeResponse>(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );
      return this.resolveChallengePayload(challengeResponse.data);
    } catch (error) {
      const typedError = error as {
        message?: string;
        response?: {
          status?: number;
          data?: unknown;
        };
      };
      const statusCode = typedError.response?.status;
      this.logger.warn({
        message: 'Unable to validate Marathon Match challenge id.',
        challengeId,
        url,
        statusCode: statusCode ?? null,
        responseBody: typedError.response?.data ?? null,
        error: typedError.message ?? String(error),
      });

      if (statusCode === 400) {
        throw new BadRequestException(
          `Challenge ID ${challengeId} is invalid.`,
        );
      }

      if (statusCode === 404) {
        throw new NotFoundException(
          `Challenge with ID ${challengeId} not found.`,
        );
      }

      throw new InternalServerErrorException(
        'Unable to validate challengeId at this time.',
      );
    }
  }

  /**
   * Normalizes challenge-api response variants to a challenge payload.
   * @param responseBody Raw challenge-api response body.
   * @returns Challenge payload that contains phases/currentPhase fields.
   */
  private resolveChallengePayload(
    responseBody: ChallengeResponse,
  ): ChallengeResponse {
    if (responseBody.result?.content) {
      return responseBody.result.content;
    }

    if (responseBody.result?.phases || responseBody.result?.currentPhase) {
      return responseBody.result;
    }

    return responseBody;
  }

  /**
   * Returns challenge phases from the resolved payload, including currentPhase as a fallback.
   * @param challengePayload Normalized challenge payload from challenge-api.
   * @returns Challenge phases available for scorer configuration.
   */
  private resolveChallengePhases(
    challengePayload: ChallengeResponse,
  ): ChallengePhaseResponse[] {
    if (
      Array.isArray(challengePayload.phases) &&
      challengePayload.phases.length > 0
    ) {
      return challengePayload.phases;
    }

    return challengePayload.currentPhase ? [challengePayload.currentPhase] : [];
  }

  /**
   * Extracts the canonical challenge phase definition identifier for persistence.
   * @param phase Challenge phase payload from challenge-api.
   * @returns Canonical phase identifier, preferring `phaseId` and falling back to `id`.
   */
  private extractCanonicalChallengePhaseId(
    phase?: ChallengePhaseResponse | null,
  ): string | null {
    const phaseId = (phase?.phaseId ?? phase?.id ?? '').trim();
    return phaseId.length > 0 ? phaseId : null;
  }

  /**
   * Extracts all accepted identifiers for a challenge phase.
   * @param phase Challenge phase payload from challenge-api.
   * @returns Unique identifiers including canonical `phaseId` and legacy instance `id`.
   */
  private extractChallengePhaseIdentifiers(
    phase?: ChallengePhaseResponse | null,
  ): string[] {
    const canonicalPhaseId = (phase?.phaseId ?? '').trim();
    const challengePhaseId = (phase?.id ?? '').trim();
    const identifiers = [canonicalPhaseId, challengePhaseId].filter(
      (identifier): identifier is string => identifier.length > 0,
    );

    return [...new Set(identifiers)];
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
      systemTestTimeout:
        config.systemTestTimeout ?? this.defaultSystemTestTimeout,
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
   * Verifies that an inbound review scorecard id resolves through review-api.
   * Accepts either the canonical review-api id or a legacy scorecard id.
   * @param scorecardId Review scorecard identifier submitted on create/update input.
   * @throws BadRequestException When review-api reports the scorecard does not exist.
   * @throws InternalServerErrorException When the scorecard cannot be validated because dependencies are unavailable.
   */
  private async validateReviewScorecardId(scorecardId: string): Promise<void> {
    const rawScorecardId = scorecardId.trim();
    if (!rawScorecardId) {
      throw new BadRequestException('Review scorecard ID must not be blank.');
    }

    const cached = this.scorecardIdLookupCache.get(rawScorecardId);
    if (cached !== undefined) {
      if (cached === null) {
        throw new BadRequestException(
          `Review scorecard ID ${rawScorecardId} is invalid or not found.`,
        );
      }
      return;
    }

    let token: string;
    try {
      token = await this.m2mService.getM2MToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({
        message:
          'Unable to validate Marathon Match review scorecard id because M2M token retrieval failed.',
        requestedScorecardId: rawScorecardId,
        error: message,
      });
      throw new InternalServerErrorException(
        'Unable to validate reviewScorecardId at this time.',
      );
    }

    if (!token) {
      this.logger.warn({
        message:
          'Unable to validate Marathon Match review scorecard id because M2M token retrieval returned an empty token.',
        requestedScorecardId: rawScorecardId,
      });
      throw new InternalServerErrorException(
        'Unable to validate reviewScorecardId at this time.',
      );
    }

    const url = `${this.buildReviewApiBaseUrl()}/scorecards/${encodeURIComponent(rawScorecardId)}`;

    try {
      const response = await firstValueFrom(
        this.httpService.get<{ id?: string }>(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      const resolvedScorecardId = response.data?.id?.trim() || '';
      if (!resolvedScorecardId) {
        this.logger.warn({
          message:
            'Scorecard validation lookup succeeded but did not return a canonical scorecard id.',
          requestedScorecardId: rawScorecardId,
          url,
        });
        throw new InternalServerErrorException(
          'Unable to validate reviewScorecardId at this time.',
        );
      }

      this.scorecardIdLookupCache.set(rawScorecardId, resolvedScorecardId);
    } catch (error) {
      if (error instanceof InternalServerErrorException) {
        throw error;
      }

      const typedError = error as {
        message?: string;
        response?: {
          status?: number;
          data?: unknown;
        };
      };
      const statusCode = typedError.response?.status;
      this.logger.warn({
        message: 'Unable to validate Marathon Match review scorecard id.',
        requestedScorecardId: rawScorecardId,
        url,
        statusCode: statusCode ?? null,
        responseBody: typedError.response?.data ?? null,
        error: typedError.message ?? String(error),
      });

      if (statusCode === 400 || statusCode === 404) {
        this.scorecardIdLookupCache.set(rawScorecardId, null);
        throw new BadRequestException(
          `Review scorecard ID ${rawScorecardId} is invalid or not found.`,
        );
      }

      throw new InternalServerErrorException(
        'Unable to validate reviewScorecardId at this time.',
      );
    }
  }

  /**
   * Resolves review scorecard identifiers to canonical review-api ids.
   * Stored configs may still contain legacy ids, while downstream review creation
   * requires the current scorecard primary key.
   * @param scorecardId Stored scorecard identifier from Marathon Match config.
   * @returns Canonical review-api scorecard id, or `undefined` when lookup fails.
   */
  private async resolveReviewScorecardId(
    scorecardId: string | undefined,
  ): Promise<string | undefined> {
    const rawScorecardId = scorecardId?.trim();
    if (!rawScorecardId) {
      return undefined;
    }

    const cached = this.scorecardIdLookupCache.get(rawScorecardId);
    if (cached !== undefined) {
      return cached ?? undefined;
    }

    let token: string;
    try {
      token = await this.m2mService.getM2MToken();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({
        message:
          'Unable to resolve Marathon Match review scorecard id because M2M token retrieval failed.',
        requestedScorecardId: rawScorecardId,
        error: message,
      });
      return undefined;
    }

    if (!token) {
      this.logger.warn({
        message:
          'Unable to resolve Marathon Match review scorecard id because M2M token retrieval returned an empty token.',
        requestedScorecardId: rawScorecardId,
      });
      return undefined;
    }

    const url = `${this.buildReviewApiBaseUrl()}/scorecards/${encodeURIComponent(rawScorecardId)}`;

    try {
      const response = await firstValueFrom(
        this.httpService.get<{ id?: string }>(url, {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }),
      );

      const resolvedScorecardId = response.data?.id?.trim() || '';

      if (!resolvedScorecardId) {
        this.logger.warn({
          message:
            'Scorecard lookup succeeded but did not return a canonical scorecard id.',
          requestedScorecardId: rawScorecardId,
          url,
        });
        return undefined;
      }

      this.scorecardIdLookupCache.set(rawScorecardId, resolvedScorecardId);
      return resolvedScorecardId;
    } catch (error) {
      const typedError = error as {
        message?: string;
        response?: {
          status?: number;
          data?: unknown;
        };
      };

      const statusCode = typedError.response?.status;
      this.logger.warn({
        message:
          'Unable to resolve Marathon Match review scorecard id from review-api.',
        requestedScorecardId: rawScorecardId,
        url,
        statusCode: statusCode ?? null,
        responseBody: typedError.response?.data ?? null,
        error: typedError.message ?? String(error),
      });

      if (statusCode === 400 || statusCode === 404) {
        this.scorecardIdLookupCache.set(rawScorecardId, null);
      }

      return undefined;
    }
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
      startSeed: phaseConfigData.startSeed.toString(),
      numberOfTests: phaseConfigData.numberOfTests,
      phaseId: phaseConfigData.phaseId,
      createdAt: phaseConfigData.createdAt,
      updatedAt: phaseConfigData.updatedAt,
    };
  }

  /**
   * Normalizes phase start seeds to BigInt before persistence and validates the complete seed range.
   * @param challengeId Challenge ID for context in validation errors.
   * @param phaseConfigs Candidate phase configs to normalize.
   * @returns Phase configs with `startSeed` converted to BigInt.
   * @throws BadRequestException When any phase seed range cannot fit in PostgreSQL BIGINT/Java long.
   */
  private normalizeStartSeeds(
    challengeId: string,
    phaseConfigs: MarathonMatchPhaseConfigInput[],
  ): NormalizedPhaseConfigInput[] {
    return phaseConfigs.map(({ phase, configType }) => {
      if (!phase) {
        return { phase, configType };
      }

      const startSeed = this.parseStartSeed(phase.startSeed);
      if (startSeed === null) {
        throw new BadRequestException(
          `Invalid startSeed for ${configType} phase in challenge ${challengeId}. startSeed must be a non-negative 64-bit integer string between 0 and 9223372036854775807.`,
        );
      }

      if (
        !Number.isSafeInteger(phase.numberOfTests) ||
        phase.numberOfTests < 1
      ) {
        throw new BadRequestException(
          `Invalid numberOfTests for ${configType} phase in challenge ${challengeId}. numberOfTests must be a positive safe integer.`,
        );
      }

      const endSeed = startSeed + BigInt(phase.numberOfTests) - BigInt(1);
      if (endSeed > MarathonMatchConfigService.maxStartSeed) {
        throw new BadRequestException(
          `Invalid seed range for ${configType} phase in challenge ${challengeId}. startSeed + numberOfTests - 1 must be at most 9223372036854775807.`,
        );
      }

      return {
        configType,
        phase: {
          ...phase,
          startSeed,
        },
      };
    });
  }

  /**
   * Parses a request start seed into a BigInt that can be stored and passed to Java as a long.
   * @param value Candidate seed from DTO validation or a programmatic service call.
   * @returns Parsed BigInt seed, or null when the value is invalid.
   */
  private parseStartSeed(value: unknown): bigint | null {
    let parsed: bigint;

    if (typeof value === 'bigint') {
      parsed = value;
    } else if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        return null;
      }
      parsed = BigInt(value);
    } else if (typeof value === 'string') {
      const normalized = value.trim();
      if (!/^(0|[1-9]\d*)$/.test(normalized)) {
        return null;
      }
      parsed = BigInt(normalized);
    } else {
      return null;
    }

    if (
      parsed < BigInt(0) ||
      parsed > MarathonMatchConfigService.maxStartSeed
    ) {
      return null;
    }

    return parsed;
  }

  /**
   * Extracts review-api review arrays from common direct, paginated, and
   * wrapped response payload shapes.
   * @param data Raw review-api response body.
   * @returns Normalized review records.
   */
  private extractReviewArray(data: unknown): Record<string, unknown>[] {
    if (Array.isArray(data)) {
      return data.map((entry) => this.asRecord(entry));
    }

    const wrapper = this.asRecord(data);
    if (Array.isArray(wrapper.data)) {
      return wrapper.data.map((entry) => this.asRecord(entry));
    }

    const resultRecord = this.asRecord(wrapper.result);
    if (Array.isArray(resultRecord.content)) {
      return resultRecord.content.map((entry) => this.asRecord(entry));
    }

    if (Array.isArray(resultRecord.data)) {
      return resultRecord.data.map((entry) => this.asRecord(entry));
    }

    return [];
  }

  /**
   * Parses total page count from response body metadata or pagination headers.
   * @param data Raw response body.
   * @param headers HTTP response headers, if available.
   * @returns Positive total page count, defaulting to 1.
   */
  private parseTotalPages(
    data: unknown,
    headers: Record<string, unknown> | undefined,
  ): number {
    const bodyTotalPages = this.extractBodyTotalPages(data);
    if (bodyTotalPages !== null) {
      return bodyTotalPages;
    }

    const totalPagesValue =
      headers?.['x-total-pages'] ??
      headers?.['X-Total-Pages'] ??
      headers?.['x-total-page'];
    return this.parsePositiveInteger(totalPagesValue) ?? 1;
  }

  /**
   * Extracts total page count from common API response metadata shapes.
   * @param data Raw response body.
   * @returns Positive total page count, or null when no value exists.
   */
  private extractBodyTotalPages(data: unknown): number | null {
    const wrapper = this.asRecord(data);
    const resultRecord = this.asRecord(wrapper.result);
    const resultContentRecord = this.asRecord(resultRecord.content);
    const dataRecord = this.asRecord(wrapper.data);
    const candidates = [
      this.asRecord(wrapper.meta),
      this.asRecord(resultRecord.meta),
      this.asRecord(resultContentRecord.meta),
      this.asRecord(dataRecord.meta),
      this.asRecord(wrapper.pagination),
      this.asRecord(resultRecord.pagination),
      this.asRecord(resultContentRecord.pagination),
      this.asRecord(dataRecord.pagination),
      wrapper,
      resultRecord,
      resultContentRecord,
      dataRecord,
    ];

    for (const candidate of candidates) {
      const totalPages = this.parsePositiveInteger(candidate.totalPages);
      if (totalPages !== null) {
        return totalPages;
      }
    }

    return null;
  }

  /**
   * Parses a positive integer from scalar or array-like API metadata values.
   * @param value Candidate positive integer value.
   * @returns Parsed positive integer, or null when unavailable.
   */
  private parsePositiveInteger(value: unknown): number | null {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const parsed = this.parsePositiveInteger(entry);
        if (parsed !== null) {
          return parsed;
        }
      }

      return null;
    }

    const parsed = Number.parseInt(this.asString(value) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }

  /**
   * Normalizes unknown values into plain records for response parsing.
   * @param value Candidate object value.
   * @returns Plain record or an empty record when not object-like.
   */
  private asRecord(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : {};
  }

  /**
   * Normalizes primitive API values to strings when possible.
   * @param value Candidate string, number, bigint, or boolean.
   * @returns String representation, or undefined for unsupported values.
   */
  private asString(value: unknown): string | undefined {
    if (typeof value === 'string') {
      return value;
    }

    if (
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      typeof value === 'boolean'
    ) {
      return String(value);
    }

    return undefined;
  }

  /**
   * Resolves an actor string for audit-aware logging and error context.
   * @param user Authenticated user or machine token payload.
   * @returns Actor identifier string.
   */
  private getActor(user: JwtUser): string {
    return user.isMachine ? 'System' : (user.userId ?? 'Unknown');
  }

  /**
   * Reads a positive integer environment variable with a default fallback.
   * @param envName Environment variable name.
   * @param defaultValue Value used when the env var is missing or invalid.
   * @returns Parsed positive integer, or the provided default value.
   */
  private getPositiveIntegerEnv(envName: string, defaultValue: number): number {
    const parsed = Number.parseInt(process.env[envName] ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultValue;
  }

  /**
   * Builds the canonical review-api v6 base URL.
   * @returns Base URL used for scorecard resolution lookups.
   */
  private buildReviewApiBaseUrl(): string {
    const baseUrl = (
      process.env.REVIEW_API_URL || 'https://api.topcoder-dev.com'
    ).replace(/\/+$/, '');
    const normalizedBase = baseUrl.replace(
      /\/(reviewSummations|reviews|scorecards)$/,
      '',
    );

    if (normalizedBase.endsWith('/v6')) {
      return normalizedBase;
    }

    return `${normalizedBase}/v6`;
  }
}
