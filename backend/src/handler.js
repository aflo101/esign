// Lambda entrypoint.
//
// Secrets live in SSM Parameter Store (free) rather than Secrets Manager ($0.40/secret/mo,
// which would have tripled this system's running cost). They must be in process.env BEFORE
// server.js is imported — its startup guard refuses to boot without JWT_SECRET, and that fail-closed behavior is deliberate.
//
// Resolution happens once per cold start and is cached for the life of the container.
import { SSMClient, GetParametersCommand } from '@aws-sdk/client-ssm';
import serverlessHttp from 'serverless-http';

const ssm = new SSMClient({});

const PARAMS = {
  JWT_SECRET: process.env.JWT_SECRET_PARAM,
  SENDER_PASSWORD: process.env.SENDER_PASSWORD_PARAM,
  ORIGIN_SECRET: process.env.ORIGIN_SECRET_PARAM,
};

let wrapped = null;

async function init() {
  const names = Object.values(PARAMS).filter(Boolean);
  if (names.length) {
    const out = await ssm.send(new GetParametersCommand({ Names: names, WithDecryption: true }));
    // SENDER_PASSWORD is legacy (cutover only) and optional — its absence must not stop boot.
    const invalid = (out.InvalidParameters || []).filter(n => n !== PARAMS.SENDER_PASSWORD);
    if (invalid.length) {
      // Fail loudly. Booting without these would break sender auth.
      throw new Error(`missing SSM parameters: ${invalid.join(', ')}`);
    }
    const byName = Object.fromEntries(out.Parameters.map(p => [p.Name, p.Value]));
    for (const [envKey, paramName] of Object.entries(PARAMS)) {
      if (paramName && byName[paramName] !== undefined) process.env[envKey] = byName[paramName];
    }
  }
  const { app } = await import('./server.js');
  return serverlessHttp(app);
}

export const handler = async (event, context) => {
  wrapped ||= await init();
  return wrapped(event, context);
};
