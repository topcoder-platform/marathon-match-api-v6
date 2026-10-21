import { Injectable, OnModuleInit, UnauthorizedException } from '@nestjs/common';
import { auth } from 'tc-core-library-js';
import { UserRole } from '../../enums/userRole.enum';
import axios from 'axios';

export interface JwtUser {
  kind?: 'user' | 'service';
  clientId?: string;
  userId?: string;
  handle?: string;
  roles?: UserRole[];
  scopes?: string[];
  isMachine: boolean;
}

/** Preserves domain administrator policy for a verified caller; takes user, returns authority, does not throw. */
export const isAdmin = (user: JwtUser): boolean => {
  if (!user) {
    return false;
  }

  if (user.isMachine) {
    return true;
  }

  if (!Array.isArray(user.roles)) {
    return false;
  }

  const normalizedRoles = user.roles
    .map((role) => String(role).trim().toLowerCase())
    .filter((role) => role.length > 0);

  const adminRole = String(UserRole.Admin).trim().toLowerCase();

  return normalizedRoles.includes(adminRole);
};

/** Adapts the common validator to legacy string member IDs; token trust and classification stay in core. */
@Injectable()
export class JwtService implements OnModuleInit {
  private validator?: ReturnType<typeof auth.createValidator>;

  /** Initializes explicit Keycloak/member configuration after startup; takes no arguments and throws for invalid settings. */
  onModuleInit(): void {
    this.validator = auth.createValidator();
  }

  /**
   * Verifies a bearer token and maps only its member ID representation for domain code.
   * @param rawToken Compact JWT or Bearer-prefixed header.
   * @returns Verified service/member identity with exact scopes and normalized roles.
   * @throws UnauthorizedException for invalid tokens or unavailable validation.
   */
  async validateToken(rawToken: string): Promise<JwtUser> {
    try {
      if (!this.validator) throw new Error('Validator unavailable');
      const token = rawToken.replace(/^Bearer /, '').trim();
      const principal = await this.validator.verify(token);
      if (principal.kind === 'user') await this.validateActiveUserSession(token, principal.iss);
      return { ...principal,
        userId: principal.userId === undefined ? undefined : String(principal.userId),
        roles: principal.roles as UserRole[],
      };
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  /**
   * Preserves the additional logout/session check for verified member tokens.
   * @param token Already verified member JWT; never logged or sent to a token-supplied host.
   * @param issuer Verified issuer used only to select a fixed Topcoder Identity endpoint.
   * @returns Nothing after an active-session response or a configured policy exemption.
   * @throws UnauthorizedException when session validation fails; network errors propagate to validateToken's sanitized failure.
   */
  private async validateActiveUserSession(token: string, issuer: string): Promise<void> {
    if ((process.env.AUTHORIZATION_SESSION_VALIDATION_ENABLED ?? 'true').trim().toLowerCase() === 'false') return;
    const normalizedIssuer = issuer.replace(/\/+$/, '');
    const supportedIssuers = ['https://api.topcoder.com', 'https://api.topcoder-dev.com'];
    const url = process.env.AUTHORIZATION_VALIDATION_URL?.trim() ||
      (supportedIssuers.includes(normalizedIssuer) ? `${normalizedIssuer}/v6/authorizations/1` : undefined);
    if (!url) return;
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw new UnauthorizedException('Invalid session validation configuration');
    const configuredTimeout = Number(process.env.AUTHORIZATION_VALIDATION_TIMEOUT_MS);
    const timeout = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 3000;
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${token}` }, params: { fields: 'token' },
      timeout, maxRedirects: 0, validateStatus: () => true,
    });
    if (response.status < 200 || response.status >= 300) throw new UnauthorizedException('Inactive token session');
  }
}
