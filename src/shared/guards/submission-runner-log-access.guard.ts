import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Request } from 'express';
import { Scope } from 'src/shared/enums/scopes.enum';
import { JwtUser, isAdmin } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

export interface RunnerLogAccessRequest extends Request {
  user?: JwtUser;
  runnerLogAccess?: {
    submissionId: string;
    challengeId: string;
  };
}

interface ChallengeResource {
  memberHandle?: unknown;
  memberId?: unknown;
  role?: unknown;
  roleId?: unknown;
  roleName?: unknown;
  resourceRole?: {
    name?: unknown;
  };
}

/**
 * Restricts runner log access to admins, scoped machine tokens, or users with
 * an allowed resource assignment on the challenge mapped to the submission.
 * Used by the submission runner log endpoint after the global token guard has
 * validated the JWT's global role or read scope.
 */
@Injectable()
export class SubmissionRunnerLogAccessGuard implements CanActivate {
  private static readonly ALLOWED_RESOURCE_ROLE_NAMES = new Set([
    'copilot',
    'manager',
    'project manager',
  ]);

  private static readonly RESOURCE_ROLE_ID_ENV_NAMES = [
    'COPILOT_RESOURCE_ROLE_ID',
    'PROJECT_MANAGER_RESOURCE_ROLE_ID',
    'MANAGER_RESOURCE_ROLE_ID',
  ];

  private readonly logger = LoggerService.forRoot(
    SubmissionRunnerLogAccessGuard.name,
  );

  private readonly resourcesApiUrl = this.resolveResourcesApiUrl();

  constructor(
    private readonly httpService: HttpService,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * Authorizes the current request against the challenge mapped to submissionId.
   * @param context Nest execution context containing the HTTP request.
   * @returns `true` when the caller may read runner logs for the mapped challenge.
   * @throws ForbiddenException When the caller is not assigned to the challenge.
   * @throws NotFoundException When no runner log mapping exists for the submission/task.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RunnerLogAccessRequest>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (isAdmin(user) || this.hasMarathonMatchReadScope(user)) {
      return true;
    }

    const submissionId = this.normalizeIdentifier(request.params?.submissionId);
    if (!submissionId) {
      throw new ForbiddenException('Submission id is required');
    }

    const challengeId = await this.findChallengeIdForSubmission(
      submissionId,
      this.getSingleQueryString(request, 'taskArn'),
    );
    const authorization = this.getAuthorizationHeader(request);
    if (!authorization) {
      throw new ForbiddenException('Authorization header is required');
    }

    const hasChallengeResource = await this.hasAllowedChallengeResource(
      challengeId,
      user,
      authorization,
    );

    if (!hasChallengeResource) {
      throw new ForbiddenException(
        'Only admins, M2M tokens, or challenge-assigned Copilot/Manager resources can read marathon match runner logs.',
      );
    }

    request.runnerLogAccess = {
      submissionId,
      challengeId,
    };

    return true;
  }

  /**
   * Checks whether the caller has a machine-token scope that authorizes runner log reads.
   * @param user Authenticated JWT payload.
   * @returns `true` when the expanded scopes include read or all marathon-match access.
   * Used by `canActivate` to keep M2M authorization independent of resource checks.
   */
  private hasMarathonMatchReadScope(user: JwtUser): boolean {
    return Array.isArray(user.scopes)
      ? user.scopes.includes(Scope.ReadMarathonMatch) ||
          user.scopes.includes(Scope.AllMarathonMatch)
      : false;
  }

  /**
   * Resolves the challenge mapped to a runner log submission/task selection.
   * @param submissionId Submission ID from the route.
   * @param taskArn Optional task ARN query value for a specific runner launch.
   * @returns Challenge ID from the newest matching runner log mapping.
   * @throws NotFoundException When no mapping exists for the submission/task.
   * Used by `canActivate` before checking resource-api challenge assignments.
   */
  private async findChallengeIdForSubmission(
    submissionId: string,
    taskArn?: string,
  ): Promise<string> {
    const mapping = await this.prisma.submissionRunnerLog.findFirst({
      where: {
        submissionId,
        ...(taskArn ? { taskArn } : {}),
      },
      orderBy: [{ createdAt: 'desc' }],
      select: {
        challengeId: true,
      },
    });

    const challengeId = this.normalizeIdentifier(mapping?.challengeId);
    if (!challengeId) {
      throw new NotFoundException(
        taskArn
          ? `No ECS runner log mapping found for submission ${submissionId} with taskArn ${taskArn}.`
          : `No ECS runner log mapping found for submission ${submissionId}.`,
      );
    }

    return challengeId;
  }

  /**
   * Fetches the current caller's resources for a challenge and checks for an allowed role.
   * @param challengeId Challenge identifier from the runner log mapping.
   * @param user Authenticated JWT payload used to constrain the resource lookup.
   * @param authorization Original request authorization header for resource-api.
   * @returns `true` when resource-api returns a matching Copilot/Manager resource.
   * @throws ForbiddenException When the caller has no member identity or resource-api cannot be checked.
   * Used by `canActivate` for challenge-specific runner log authorization.
   */
  private async hasAllowedChallengeResource(
    challengeId: string,
    user: JwtUser,
    authorization: string,
  ): Promise<boolean> {
    const memberIdentity = this.getMemberIdentity(user);
    if (!memberIdentity) {
      throw new ForbiddenException(
        'Authenticated user id or handle is required',
      );
    }

    try {
      const response = await firstValueFrom(
        this.httpService.get<unknown[]>(
          this.buildResourcesUrl(challengeId, user),
          {
            headers: {
              Authorization: authorization,
            },
          },
        ),
      );
      const resources = Array.isArray(response.data) ? response.data : [];

      return resources.some((resource) =>
        this.isCallerAllowedResource(resource, memberIdentity),
      );
    } catch (error) {
      if (error instanceof ForbiddenException) {
        throw error;
      }

      this.logger.warn({
        message: 'Failed to verify runner log challenge resource',
        challengeId,
        userId: user.userId,
        handle: user.handle,
        error: error instanceof Error ? error.message : 'unknown error',
      });

      throw new ForbiddenException(
        'Unable to verify runner log challenge resource access.',
      );
    }
  }

  /**
   * Builds the resource-api lookup URL for the current caller and challenge.
   * @param challengeId Challenge identifier to query.
   * @param user Authenticated JWT payload containing member id or handle.
   * @returns Absolute resource-api URL with challenge and caller filters.
   * Used by `hasAllowedChallengeResource`.
   */
  private buildResourcesUrl(challengeId: string, user: JwtUser): string {
    const query = new URLSearchParams({
      challengeId,
      page: '1',
      perPage: '100',
    });

    if (user.userId) {
      query.set('memberId', String(user.userId));
    } else if (user.handle) {
      query.set('memberHandle', user.handle);
    }

    return `${this.resourcesApiUrl}?${query.toString()}`;
  }

  /**
   * Checks whether a resource row belongs to the caller and uses an allowed role.
   * @param resource Raw resource-api row.
   * @param memberIdentity Normalized caller member id or handle.
   * @returns `true` when the row identifies the caller as a Copilot/Manager resource.
   * Used by `hasAllowedChallengeResource` after resource-api lookup.
   */
  private isCallerAllowedResource(
    resource: unknown,
    memberIdentity: string,
  ): boolean {
    if (typeof resource !== 'object' || !resource) {
      return false;
    }

    const typedResource = resource as ChallengeResource;
    const resourceMemberId = this.normalizeText(typedResource.memberId);
    const resourceMemberHandle = this.normalizeText(typedResource.memberHandle);
    const resourceUserMatches =
      resourceMemberId === memberIdentity ||
      resourceMemberHandle === memberIdentity;

    return resourceUserMatches && this.isAllowedResourceRole(typedResource);
  }

  /**
   * Checks whether a resource row is an allowed runner-log role assignment.
   * @param resource Raw resource-api row with role fields.
   * @returns `true` when role name or configured role id identifies Copilot/Manager.
   * Used by `isCallerAllowedResource`.
   */
  private isAllowedResourceRole(resource: ChallengeResource): boolean {
    const roleName = this.normalizeText(
      resource.roleName ?? resource.role ?? resource.resourceRole?.name,
    );

    if (
      SubmissionRunnerLogAccessGuard.ALLOWED_RESOURCE_ROLE_NAMES.has(roleName)
    ) {
      return true;
    }

    const roleId = this.normalizeText(resource.roleId);
    if (!roleId) {
      return false;
    }

    return SubmissionRunnerLogAccessGuard.RESOURCE_ROLE_ID_ENV_NAMES.some(
      (envName) => this.normalizeText(process.env[envName]) === roleId,
    );
  }

  /**
   * Resolves the caller's member identity for resource matching.
   * @param user Authenticated JWT payload.
   * @returns Normalized user id when present, otherwise normalized handle; `undefined` when absent.
   * Used by `hasAllowedChallengeResource`.
   */
  private getMemberIdentity(user: JwtUser): string | undefined {
    return this.normalizeText(user.userId) || this.normalizeText(user.handle);
  }

  /**
   * Reads the original bearer token from the request headers.
   * @param request Express request passed through Nest.
   * @returns The authorization header value, or `undefined` when missing.
   * Used by `canActivate` for the resource-api verification request.
   */
  private getAuthorizationHeader(request: Request): string | undefined {
    const authorization = request.headers.authorization;

    return Array.isArray(authorization)
      ? this.normalizeHeaderValue(authorization[0])
      : this.normalizeHeaderValue(authorization);
  }

  /**
   * Reads a single query string value while ignoring non-string objects.
   * @param request Express request containing parsed query values.
   * @param name Query parameter name.
   * @returns Trimmed query string value, or `undefined` when missing.
   * Used by `canActivate` to scope authorization to the requested task ARN.
   */
  private getSingleQueryString(
    request: Request,
    name: string,
  ): string | undefined {
    const value = request.query?.[name];
    const normalizedValue = Array.isArray(value)
      ? this.normalizeIdentifier(value[0])
      : this.normalizeIdentifier(value);

    return normalizedValue || undefined;
  }

  /**
   * Resolves the resource-api endpoint used to fetch challenge resources.
   * @returns Configured resources endpoint, or a default derived from the challenge-api base URL.
   * Used during guard construction so tests and deployments can override the endpoint.
   */
  private resolveResourcesApiUrl(): string {
    const configuredResourcesApiUrl =
      process.env.RESOURCES_API_URL?.trim() ||
      process.env.RESOURCE_API_URL?.trim();

    if (configuredResourcesApiUrl) {
      return configuredResourcesApiUrl.replace(/\/+$/, '');
    }

    const topcoderApiBaseUrl =
      process.env.CHALLENGE_API_URL?.replace(/\/+$/, '') ||
      'https://api.topcoder-dev.com';

    return `${topcoderApiBaseUrl}/v6/resources`;
  }

  /**
   * Normalizes user/resource values for case-insensitive comparison.
   * @param value Raw value from JWT payloads, resource rows, or env vars.
   * @returns Lower-cased trimmed string, or an empty string for missing values.
   * Used by guard comparisons.
   */
  private normalizeText(value: unknown): string {
    if (value === undefined || value === null) {
      return '';
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return '';
    }

    return String(value).trim().toLowerCase();
  }

  /**
   * Normalizes route/query identifiers while preserving case.
   * @param value Raw route, query, or database value.
   * @returns Trimmed string, or an empty string for missing/non-scalar values.
   * Used for exact submission and task mapping lookups.
   */
  private normalizeIdentifier(value: unknown): string {
    if (value === undefined || value === null) {
      return '';
    }

    if (
      typeof value !== 'string' &&
      typeof value !== 'number' &&
      typeof value !== 'boolean'
    ) {
      return '';
    }

    return String(value).trim();
  }

  /**
   * Normalizes request header values while preserving token casing.
   * @param value Raw request header value.
   * @returns Trimmed header value, or `undefined` when empty.
   * Used by `getAuthorizationHeader`.
   */
  private normalizeHeaderValue(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const normalizedValue = value.trim();

    return normalizedValue || undefined;
  }
}
