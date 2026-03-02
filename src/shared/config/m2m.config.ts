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
