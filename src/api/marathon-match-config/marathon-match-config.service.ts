import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  ConflictException,
  HttpException,
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
 * manual rerun dispatching for the latest challenge submissions, and
 * tester-change reruns for active challenges.
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
  private readonly scorecardIdLookupCache = new Map<string, string | null>();

  constructor(
    private readonly httpService: HttpService,
    private readonly ecsService: EcsService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
    private readonly prismaErrorService: PrismaErrorService,
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
    const taskDefinitionName =
      process.env.DEFAULT_TASK_DEFINITION_NAME?.trim() || '';
    const taskDefinitionVersion =
      process.env.DEFAULT_TASK_DEFINITION_VERSION?.trim() || '';

    return {
      reviewScorecardId,
      testTimeout,
      compileTimeout,
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
   * Uses the challenge's PROVISIONAL phase config to mirror active-challenge
   * submission scoring, validates active/open challenge runtime state through
   * challenge-api, reduces submission API results to one latest submission
   * per member, and launches ECS scorer tasks in bounded batches to avoid
   * RunTask API throttling.
   * @param challengeId Challenge ID from path params in POST /challenge/:challengeId/rerun.
   * @param user Authenticated user or machine token payload for audit-aware logging.
   * @returns Rerun dispatch summary mapped to `RerunResponseDto`.
   * @throws NotFoundException When the marathon match config does not exist.
   * @throws BadRequestException When the config/challenge is inactive, the challenge has no open phase,
   * the tester is not compiled successfully, or no PROVISIONAL phase config exists.
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

      const provisionalPhaseConfig = config.phaseConfigs.find(
        (phaseConfigData) =>
          phaseConfigData.configType === PhaseConfigType.PROVISIONAL,
      );
      if (!provisionalPhaseConfig) {
        throw new BadRequestException(
          `Marathon match config ${challengeId} requires a PROVISIONAL phase config for rerun.`,
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

        const currentPhaseId = extractPhaseId(challengePayload.currentPhase);
        return currentPhaseId ? [currentPhaseId] : [];
      };
      type RerunSubmissionCandidate = {
        submissionId: string;
        memberId: string;
        submittedDate: string;
        receivedOrSubmittedDate: string;
        sortTimestamp: number;
        isLatest?: boolean;
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

      if (extractOpenPhaseIds(challengeResponse.data).length === 0) {
        throw new BadRequestException(
          `Challenge ${challengeId} has no open phase. Rerun is allowed only for ACTIVE Marathon Match challenges.`,
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
          submittedDate: submission.submittedDate,
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
          configType: provisionalPhaseConfig.configType,
          startSeed: provisionalPhaseConfig.startSeed,
          numberOfTests: provisionalPhaseConfig.numberOfTests,
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
   * Launches rerun scorer tasks in small batches so ECS RunTask requests remain below service throttling limits.
   * @param challengeId Challenge ID passed to each scorer task.
   * @param submissions Latest submissions to rerun, in response order.
   * @param mmConfig Task definition name and version from the marathon match config.
   * @param scoringPhase PROVISIONAL phase settings passed to scorer tasks.
   * @returns Settled launch results in the same order as `submissions`.
   * @throws Does not throw for individual scorer launch failures; those are returned as rejected settled results.
   */
  private async launchScorerTasksWithRateLimit(
    challengeId: string,
    submissions: { submissionId: string }[],
    mmConfig: {
      taskDefinitionName: string;
      taskDefinitionVersion: string;
    },
    scoringPhase: {
      configType: PhaseConfigType;
      startSeed: bigint;
      numberOfTests: number;
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
        batch.map(({ submissionId }) =>
          this.ecsService.launchScorerTask(
            challengeId,
            submissionId,
            mmConfig,
            scoringPhase,
          ),
        ),
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
   * Resolves an actor string for audit-aware logging and error context.
   * @param user Authenticated user or machine token payload.
   * @returns Actor identifier string.
   */
  private getActor(user: JwtUser): string {
    return user.isMachine ? 'System' : (user.userId ?? 'Unknown');
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
