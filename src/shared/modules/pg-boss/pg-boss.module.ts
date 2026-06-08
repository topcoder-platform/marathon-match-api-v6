import { Module } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { PG_BOSS_TOKEN } from './pg-boss.constants';
import { PgBossLifecycleService } from './pg-boss-lifecycle.service';

export { PG_BOSS_TOKEN } from './pg-boss.constants';

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
    PgBossLifecycleService,
  ],
  exports: [PG_BOSS_TOKEN, PgBossLifecycleService],
})
export class PgBossModule {}
