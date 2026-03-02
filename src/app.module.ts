import { MiddlewareConsumer, Module } from '@nestjs/common';
import { ApiModule } from './api/api.module';
import { KafkaModule } from './shared/modules/kafka/kafka.module';
import { CreateRequestStoreMiddleware } from './shared/request/createRequestStore.middleware';
import { TokenValidatorMiddleware } from './shared/request/tokenRequestValidator.middleware';

@Module({
  imports: [ApiModule, KafkaModule.forRoot()],
  controllers: [],
  providers: [],
})
export class AppModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(TokenValidatorMiddleware).forRoutes('*');
    consumer.apply(CreateRequestStoreMiddleware).forRoutes('*');
  }
}
