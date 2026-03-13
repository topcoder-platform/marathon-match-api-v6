import { HttpService } from '@nestjs/axios';
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
import { EcsService } from 'src/shared/modules/global/ecs.service';
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
 * and manual rerun dispatching for the latest challenge submissions.
 * Maps persistence records to API response DTOs for challenge config endpoints.
 */
@Injectable()
export class MarathonMatchConfigService {
  private readonly logger = LoggerService.forRoot('MarathonMatchConfigService');
  private readonly challengeApiBaseUrl =
    process.env.CHALLENGE_API_URL?.replace(/\/+$/, '') ||
    'https://api.topcoder-dev.com';

  constructor(
    private readonly httpService: HttpService,
    private readonly ecsService: EcsService,
    private readonly m2mService: M2MService,
    private readonly prisma: PrismaService,
    private readonly prismaErrorService: PrismaErrorService,
  ) {}

  /**
   * Retrieves configurable default values for new marathon match configs from environment variables.
   * @returns Default review scorecard ID, test timeout, and compile timeout mapped to `MarathonMatchDefaultsResponseDto`.
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

    return {
      reviewScorecardId,
      testTimeout,
      compileTimeout,
    };
  }

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
   * Reruns scorer tasks for the latest submissions of an active marathon match challenge.
   * Uses the challenge's PROVISIONAL phase config to mirror active-challenge
   * submission scoring, validates active/open challenge runtime state through
   * challenge-api, and reduces submission API results to one latest submission
   * per member before delegating ECS orchestration to `EcsService`.
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

      const launchResults = await Promise.allSettled(
        submissions.map(({ submissionId }) =>
          this.ecsService.launchScorerTask(
            challengeId,
            submissionId,
            {
              taskDefinitionName: config.taskDefinitionName,
              taskDefinitionVersion: config.taskDefinitionVersion,
            },
            {
              configType: provisionalPhaseConfig.configType,
              startSeed: provisionalPhaseConfig.startSeed,
              numberOfTests: provisionalPhaseConfig.numberOfTests,
            },
          ),
        ),
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
