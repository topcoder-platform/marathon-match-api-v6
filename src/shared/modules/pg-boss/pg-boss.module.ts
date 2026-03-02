import { Module } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');

export const PG_BOSS_TOKEN = 'PG_BOSS';

/**
 * Provides a shared PgBoss instance backed by the same Postgres
 * connection used by Prisma so compilation jobs persist across restarts.
 */
@Module({
  providers: [
    {
      provide: PG_BOSS_TOKEN,
      useFactory: async (): Promise<PgBoss> => {
        const databaseUrl = process.env.DATABASE_URL;

        if (!databaseUrl) {
          throw new Error('DATABASE_URL must be set to initialize pg-boss.');
        }

        return await Promise.resolve(new PgBoss(databaseUrl));
      },
    },
  ],
  exports: [PG_BOSS_TOKEN],
})
export class PgBossModule {}
