import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { Request } from 'express';
import { Scope } from 'src/shared/enums/scopes.enum';
import { JwtUser, isAdmin } from 'src/shared/modules/global/jwt.service';
import { LoggerService } from 'src/shared/modules/global/logger.service';

type RequestWithUser = Request & {
  user?: JwtUser;
};

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
 * Allows marathon match score reruns for admins, scoped machine tokens, or the
 * authenticated copilot resource assigned to the target challenge.
 * Used on marathon match rerun endpoints after the global token guard has validated the JWT.
 */
@Injectable()
export class ChallengeCopilotResourceGuard implements CanActivate {
  private readonly logger = LoggerService.forRoot(
    ChallengeCopilotResourceGuard.name,
  );

  private readonly resourcesApiUrl = this.resolveResourcesApiUrl();

  constructor(private readonly httpService: HttpService) {}

  /**
   * Authorizes the current request against the route challenge id.
   * @param context Nest execution context containing the HTTP request.
   * @returns `true` when the user is an admin, scoped M2M caller, or challenge copilot resource.
   * @throws ForbiddenException When a non-admin user is not assigned as the challenge copilot.
   * Used by Marathon Match provisional and SYSTEM rerun routes.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('Insufficient permissions');
    }

    if (isAdmin(user) || this.hasMarathonMatchUpdateScope(user)) {
      return true;
    }

    const challengeId = this.normalizeText(request.params?.challengeId);
    if (!challengeId) {
      throw new ForbiddenException('Challenge id is required');
    }

    const authorization = this.getAuthorizationHeader(request);
    if (!authorization) {
      throw new ForbiddenException('Authorization header is required');
    }

    const hasChallengeCopilotResource = await this.hasChallengeCopilotResource(
      challengeId,
      user,
      authorization,
    );

    if (!hasChallengeCopilotResource) {
      throw new ForbiddenException(
        'Only admins, M2M tokens, or the challenge copilot resource can rerun marathon match scores.',
      );
    }

    return true;
  }

  /**
   * Checks whether the caller has a machine-token scope that authorizes marathon match updates.
   * @param user Authenticated JWT payload.
   * @returns `true` when the expanded scopes include update or all marathon-match access.
   * Used by `canActivate` to keep M2M authorization independent of resource checks.
   */
  private hasMarathonMatchUpdateScope(user: JwtUser): boolean {
    return Array.isArray(user.scopes)
      ? user.scopes.includes(Scope.UpdateMarathonMatch) ||
          user.scopes.includes(Scope.AllMarathonMatch)
      : false;
  }

  /**
   * Fetches the current caller's resources for a challenge and checks for a copilot resource role.
   * @param challengeId Challenge identifier from the rerun route.
   * @param user Authenticated JWT payload used to constrain the resource lookup.
   * @param authorization Original request authorization header for resource-api.
   * @returns `true` when resource-api returns a matching copilot resource for the caller.
   * @throws ForbiddenException When the caller has no member identity or resource-api cannot be checked.
   * Used by `canActivate` for challenge-specific copilot authorization.
   */
  private async hasChallengeCopilotResource(
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
        this.isCallerCopilotResource(resource, memberIdentity),
      );
    } catch (error) {
      this.logger.warn({
        message: 'Failed to verify challenge copilot resource',
        challengeId,
        userId: user.userId,
        handle: user.handle,
        error: error instanceof Error ? error.message : 'unknown error',
      });

      throw new ForbiddenException(
        'Unable to verify challenge copilot resource access.',
      );
    }
  }

  /**
   * Builds the resource-api lookup URL for the current caller and challenge.
   * @param challengeId Challenge identifier to query.
   * @param user Authenticated JWT payload containing member id or handle.
   * @returns Absolute resource-api URL with challenge and caller filters.
   * Used by `hasChallengeCopilotResource`.
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
   * Checks whether a resource row belongs to the caller and uses the Copilot role.
   * @param resource Raw resource-api row.
   * @param memberIdentity Normalized caller member id or handle.
   * @returns `true` when the resource row identifies the caller as a copilot resource.
   * Used by `hasChallengeCopilotResource` after resource-api lookup.
   */
  private isCallerCopilotResource(
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

    return resourceUserMatches && this.isCopilotResource(typedResource);
  }

  /**
   * Checks whether a resource row is a Copilot role assignment.
   * @param resource Raw resource-api row with role fields.
   * @returns `true` when the role name or configured role id identifies Copilot.
   * Used by `isCallerCopilotResource`.
   */
  private isCopilotResource(resource: ChallengeResource): boolean {
    const roleName = this.normalizeText(
      resource.roleName ?? resource.role ?? resource.resourceRole?.name,
    );
    const configuredCopilotRoleId = this.normalizeText(
      process.env.COPILOT_RESOURCE_ROLE_ID,
    );

    return (
      roleName === 'copilot' ||
      (!!configuredCopilotRoleId &&
        this.normalizeText(resource.roleId) === configuredCopilotRoleId)
    );
  }

  /**
   * Resolves the caller's member identity for resource matching.
   * @param user Authenticated JWT payload.
   * @returns Normalized user id when present, otherwise normalized handle; `undefined` when absent.
   * Used by `hasChallengeCopilotResource`.
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
   * @param value Raw value from JWT payloads, route params, resource rows, or env vars.
   * @returns Lower-cased trimmed string, or an empty string for missing values.
   * Used by all guard comparisons.
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
