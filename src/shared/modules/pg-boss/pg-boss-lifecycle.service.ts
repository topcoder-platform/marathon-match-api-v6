import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import PgBoss = require('pg-boss');
import { LoggerService } from '../global/logger.service';
import { PG_BOSS_TOKEN } from './pg-boss.constants';

/**
 * Starts and stops the shared PgBoss instance once for all background workers.
 * Services that register workers call `ensureStarted` before creating queues or
 * sending jobs, while this lifecycle service owns the final shutdown.
 */
@Injectable()
export class PgBossLifecycleService implements OnModuleDestroy {
  private readonly logger = LoggerService.forRoot('PgBossLifecycleService');
  private startPromise?: Promise<PgBoss>;

  constructor(@Inject(PG_BOSS_TOKEN) private readonly pgBoss: PgBoss) {}

  /**
   * Ensures the shared PgBoss instance is started.
   * @returns The started PgBoss instance.
   * @throws Error when PgBoss startup or migrations fail.
   */
  async ensureStarted(): Promise<PgBoss> {
    if (!this.startPromise) {
      this.startPromise = this.pgBoss.start();
    }

    return this.startPromise;
  }

  /**
   * Stops the shared PgBoss instance during Nest application shutdown.
   * @returns Promise that resolves after PgBoss stops or when it was never started.
   */
  async onModuleDestroy(): Promise<void> {
    if (!this.startPromise) {
      return;
    }

    try {
      await this.startPromise;
      await this.pgBoss.stop();
    } catch (error) {
      this.logger.warn({
        message: 'Unable to stop shared PgBoss instance cleanly.',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
