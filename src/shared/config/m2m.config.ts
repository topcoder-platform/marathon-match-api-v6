/**
 * Auth0 M2M settings, read once at startup with the defaults used before the Keycloak
 * migration. {@link M2MService} passes them to `auth.m2m` and the core uses them only
 * when `USE_KEYCLOAK` is unset or `false`; with `USE_KEYCLOAK=true` the core reads the
 * `KEYCLOAK_*` settings instead and ignores these values.
 */
export const M2mConfig = {
  auth0: {
    url: process.env.AUTH0_URL ?? 'http://localhost:4000/oauth/token',
    domain: process.env.AUTH0_DOMAIN ?? 'topcoder-dev.auth0.com',
    audience: process.env.AUTH0_AUDIENCE ?? 'https://m2m.topcoder-dev.com/',
    proxyUrl: process.env.AUTH0_PROXY_SERVER_URL,
    clientId: process.env.AUTH0_CLIENT_ID,
    clientSecret: process.env.AUTH0_CLIENT_SECRET,
  },
};
