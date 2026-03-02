import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GlobalProvidersModule } from 'src/shared/modules/global/globalProviders.module';
import { PgBossModule } from 'src/shared/modules/pg-boss/pg-boss.module';
import { HealthCheckController } from './health-check/healthCheck.controller';
import { MarathonMatchConfigController } from './marathon-match-config/marathon-match-config.controller';
import { MarathonMatchConfigService } from './marathon-match-config/marathon-match-config.service';
import { CompilationWorkerService } from './tester/compilation-worker.service';
import { TesterCompilationService } from './tester/tester-compilation.service';
import { TesterController } from './tester/tester.controller';
import { TesterService } from './tester/tester.service';

@Module({
  imports: [HttpModule, GlobalProvidersModule, PgBossModule],
  controllers: [
    HealthCheckController,
    TesterController,
    MarathonMatchConfigController,
  ],
  providers: [
    TesterService,
    TesterCompilationService,
    CompilationWorkerService,
    MarathonMatchConfigService,
  ],
})
export class ApiModule {}
