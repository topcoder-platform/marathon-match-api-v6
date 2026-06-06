import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GlobalProvidersModule } from 'src/shared/modules/global/globalProviders.module';
import { KafkaModule } from 'src/shared/modules/kafka/kafka.module';
import { PgBossModule } from 'src/shared/modules/pg-boss/pg-boss.module';
import { ChallengeCopilotResourceGuard } from 'src/shared/guards/challenge-copilot-resource.guard';
import { SubmissionRunnerLogAccessGuard } from 'src/shared/guards/submission-runner-log-access.guard';
import { HealthCheckController } from './health-check/healthCheck.controller';
import { MarathonMatchConfigController } from './marathon-match-config/marathon-match-config.controller';
import { MarathonMatchConfigService } from './marathon-match-config/marathon-match-config.service';
import { ScoringResultController } from './scoring-result/scoring-result.controller';
import { ScoringCompletionEmailService } from './scoring-result/scoring-completion-email.service';
import { ScoringResultService } from './scoring-result/scoring-result.service';
import { SubmissionRunnerLogController } from './submission-runner-log/submission-runner-log.controller';
import { SubmissionRunnerLogService } from './submission-runner-log/submission-runner-log.service';
import { CompilationWorkerService } from './tester/compilation-worker.service';
import { TesterCompilationService } from './tester/tester-compilation.service';
import { TesterController } from './tester/tester.controller';
import { TesterService } from './tester/tester.service';

@Module({
  imports: [
    HttpModule,
    GlobalProvidersModule,
    PgBossModule,
    KafkaModule.forRoot(),
  ],
  controllers: [
    HealthCheckController,
    TesterController,
    MarathonMatchConfigController,
    ScoringResultController,
    SubmissionRunnerLogController,
  ],
  providers: [
    TesterService,
    TesterCompilationService,
    CompilationWorkerService,
    MarathonMatchConfigService,
    ScoringCompletionEmailService,
    ScoringResultService,
    SubmissionRunnerLogService,
    ChallengeCopilotResourceGuard,
    SubmissionRunnerLogAccessGuard,
  ],
})
export class ApiModule {}
