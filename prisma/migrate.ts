import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL must be set to run database migrations.');
}

const schema = process.env.POSTGRES_SCHEMA || 'marathon_match';
if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(schema)) {
  throw new Error(
    `Invalid POSTGRES_SCHEMA "${schema}". Use letters, numbers, and underscores only.`,
  );
}

const adapter = new PrismaPg({ connectionString: databaseUrl }, { schema });
const prisma = new PrismaClient({ adapter });

async function main() {
  console.log(`Using PostgreSQL schema: ${schema}`);
  await prisma.$executeRawUnsafe(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
  console.log(`Ensured PostgreSQL schema ${schema} exists`);
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
