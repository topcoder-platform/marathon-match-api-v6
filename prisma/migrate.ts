import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Using PostgreSQL schema: marathon_match');
  await prisma.$executeRawUnsafe('CREATE SCHEMA IF NOT EXISTS marathon_match');
  console.log('Ensured PostgreSQL schema marathon_match exists');
  await prisma.$disconnect();
}

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
