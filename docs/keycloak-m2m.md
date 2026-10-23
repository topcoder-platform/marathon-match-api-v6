# Keycloak M2M migration branch

This code is isolated on `keycloak_m2M`. Do not deploy this branch until the
workload and its callers are ready. Existing DEV services continue using Auth0.
The core dependency is pinned to a reviewed Keycloak prerelease commit, including
transitive wrapper uses through the pnpm override. No npm latest dependency is used.
`pnpm-lock.yaml` resolves a single 4.0.0-keycloak.1 (core commit `e844764`).

## Provider switch: `USE_KEYCLOAK`

`USE_KEYCLOAK=true` makes this service get its M2M tokens from Keycloak, using
`KEYCLOAK_TOKEN_URL`, `KEYCLOAK_AUDIENCE`, `KEYCLOAK_CLIENT_ID` and
`KEYCLOAK_CLIENT_SECRET` (optional `KEYCLOAK_SCOPE` narrows the client's defaults).
`KEYCLOAK_ISSUER` is also required. Unset or `false` restores the Auth0 behaviour from
before the migration: `M2MService` uses `AUTH0_URL` (default
`http://localhost:4000/oauth/token`), `AUTH0_AUDIENCE` (default
`https://m2m.topcoder-dev.com/`), `AUTH0_PROXY_SERVER_URL` (default `AUTH0_URL`),
`AUTH0_CLIENT_ID` and `AUTH0_CLIENT_SECRET`.

The ECS scorer runner follows the API. `EcsService` always sends `USE_KEYCLOAK`
(`true`/`false`, from `auth.useKeycloak()`) in the RunTask container overrides, plus
only the active provider's refresh settings: the five `KEYCLOAK_*` names above, or
`AUTH0_URL`, `AUTH0_AUDIENCE`, `AUTH0_PROXY_SERVER_URL`, `AUTH0_CLIENT_ID` and
`AUTH0_CLIENT_SECRET`. The Java runner parses the flag with the same rule as the core
(trimmed, case-insensitive `true`; missing/empty/`false` = Auth0; anything else stops
the runner) and in Auth0 mode refreshes exactly as the pre-migration runner did. The
runner still receives its client secret through the RunTask overrides; that existing
design is unchanged.

`tc-core-library-js` reads the flag (`auth.useKeycloak`) and `M2MService` passes the
Auth0 settings to `auth.m2m`, so the service and the core always agree. Any value other
than `true`/`false` fails at startup. The Swagger M2M token example follows the flag
too. In DEV the flag is `/config/common/global-appvar/USE_KEYCLOAK`; the CircleCI deploy
already loads `/config/marathon-match-api-v6/appvar` and `/config/common/global-appvar`.

Incoming machine tokens: with `true`, Keycloak tokens are accepted, plus Auth0 tokens
while `LEGACY_M2M_ISSUERS`/`LEGACY_M2M_AUDIENCE` are set. With `false`, Auth0 tokens
are accepted through `LEGACY_M2M_*`, plus Keycloak tokens while `KEYCLOAK_ISSUER` and
`KEYCLOAK_AUDIENCE` are set, so callers that have not switched yet keep working.

**Rollback:** set `USE_KEYCLOAK=false` and force a new deployment so tasks re-read SSM.
No code or dependency change is needed. Keep the Auth0 settings above in SSM until
Keycloak has been accepted. Scorer tasks started after the API restarts use Auth0 too.

The DEV issuer is `https://keycloak.topcoder-dev.com/realms/topcoder-m2m-dev`,
audience `https://api.topcoder-dev.com`, and managed endpoint
`https://keycloak.topcoder-dev.com/m2m/token`.

Member sessions remain Auth0. Keep `VALID_ISSUERS` and `AUTH_SECRET` where legacy
member HMAC tokens are supported. Set `AUTH_USER_AUDIENCES` to a JSON array, or
explicitly retain existing user-token audience behavior with
`ALLOW_LEGACY_USER_AUDIENCE=true`. Never apply that exception to M2M tokens.
`LEGACY_M2M_ISSUERS` and `LEGACY_M2M_AUDIENCE` let Auth0 machine tokens pass the same
normalizer (see the provider switch above).

`tc-core-library-js` owns signature, issuer, audience, lifetime, and machine/user
classification. Service adapters must use its verified `kind`, `isMachine`, and
`scopes` rather than decode/reclassify claims. Scope guards delegate exact matching
to the library with explicit all/any policy. Existing business roles and documented
scope aliases remain endpoint policy; adding OAuth scopes to a user token never
grants machine access. No permissive fallback or synthetic token path is available.

Before rollout run this project's `nvm use`, `pnpm lint`, `pnpm build`, and targeted
authentication tests. Validate real authorized/unauthorized routes with both a
Keycloak service token and a member token, including wrong audiences and insufficient
scopes. Switch only after every downstream receiver accepts the issuer. The core and
the runner never retry a failed Keycloak request against Auth0; rolling back is the
explicit `USE_KEYCLOAK=false` change above.


The validator retains exact scopes; `ALL_SCOPE_MAPPINGS` remains explicit route policy.
Domain checks retain documented read/all and delete/all alternatives. Machine tokens
never acquire member roles or IDs. Existing domain machine privileges apply only
after route scopes authorize the request. Run `pnpm test:keycloak` after building.

The existing Identity API logout/session check is preserved for verified member tokens. Machine tokens skip that member-session check only after core verifies their service identity.

Validation on 21 October 2026: Lint/build, four compiled authentication/scope checks, and all 243 Node tests pass. The compiled adapter accepted a real DEV Keycloak token. Java runner verification used the repository's maven:3.9.9-eclipse-temurin-8 builder image because the host has no Maven/JDK; mvn verify built the runner and passed all 25 Java tests. The Java project defines no separate lint/checkstyle task; Node lint passes and Java compilation/tests pass. No runner image or task was deployed.

Validation on 23 October 2026 (USE_KEYCLOAK switch): lint/build, the four compiled checks and all 249 Node tests pass (`m2m.service.spec.ts` and `ecs.service.spec.ts` prove `false`/unset selects the Auth0 settings and runner overrides, `true` the Keycloak ones). The Java runner was tested with the same maven:3.9.9-eclipse-temurin-8 image (host has no JDK/Maven): `mvn test` passes all 28 tests, including the USE_KEYCLOAK parser and an Auth0 refresh against a local endpoint, and `mvn clean package -DskipTests` builds the shaded jar.
