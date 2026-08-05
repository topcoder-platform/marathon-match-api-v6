import { Module, DynamicModule } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import {
  KafkaConsumerService,
  KafkaModuleOptions,
} from './kafka-consumer.service';
import { KafkaHandlerRegistry } from './kafka-handler.registry';
import registeredHandlersConfig from './handlers/registered-handlers.config';
import { KAFKA_TIMING_DEFAULTS } from './kafka.constants';

@Module({})
export class KafkaModule {
  private static parseNumberEnv(value?: string): number | undefined {
    if (!value) {
      return undefined;
    }

    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  static register(options: KafkaModuleOptions): DynamicModule {
    return {
      module: KafkaModule,
      imports: [HttpModule],
      providers: [
        {
          provide: 'KAFKA_OPTIONS',
          useValue: options,
        },
        KafkaHandlerRegistry,
        {
          provide: KafkaConsumerService,
          useFactory: (handlerRegistry: KafkaHandlerRegistry) => {
            return new KafkaConsumerService(options, handlerRegistry);
          },
          inject: [KafkaHandlerRegistry],
        },
        ...registeredHandlersConfig,
      ],
      exports: [KafkaConsumerService, KafkaHandlerRegistry],
    };
  }

  static forRoot(): DynamicModule {
    const brokerListValue = process.env.KAFKA_URL ?? process.env.KAFKA_BROKERS;
    const saslUsername = process.env.KAFKA_SASL_USERNAME?.trim();
    const saslPassword = process.env.KAFKA_SASL_PASSWORD ?? '';
    const saslMechanism = process.env.KAFKA_SASL_MECHANISM as
      | 'plain'
      | 'scram-sha-256'
      | 'scram-sha-512'
      | undefined;
    const configuredBrokers = brokerListValue
      ?.split(',')
      .map((broker) => broker.trim())
      .filter((broker) => broker.length > 0);

    const maxBytes =
      this.parseNumberEnv(process.env.KAFKA_MAXBYTES) ??
      this.parseNumberEnv(process.env.KAFKA_MAX_BYTES);
    const minBytes = this.parseNumberEnv(process.env.KAFKA_MIN_BYTES);

    const kafkaOptions: KafkaModuleOptions = {
      brokers:
        configuredBrokers && configuredBrokers.length > 0
          ? configuredBrokers
          : ['localhost:9092'],
      clientId: process.env.KAFKA_CLIENT_ID || 'tc-marathon-match-api',
      groupId: process.env.KAFKA_GROUP_ID || 'tc-marathon-match-consumer-group',
      ssl: process.env.KAFKA_SSL_ENABLED === 'true',
      sasl: saslUsername
        ? {
            mechanism: saslMechanism || 'plain',
            username: saslUsername,
            password: saslPassword,
          }
        : undefined,
      connectionTimeout: Number(
        process.env.KAFKA_CONNECTION_TIMEOUT ??
          KAFKA_TIMING_DEFAULTS.connectionTimeout,
      ),
      requestTimeout: Number(
        process.env.KAFKA_REQUEST_TIMEOUT ??
          KAFKA_TIMING_DEFAULTS.requestTimeout,
      ),
      brokerTimeout: Number(
        process.env.KAFKA_BROKER_TIMEOUT ?? KAFKA_TIMING_DEFAULTS.brokerTimeout,
      ),
      sessionTimeout: Number(
        process.env.KAFKA_SESSION_TIMEOUT ??
          KAFKA_TIMING_DEFAULTS.sessionTimeout,
      ),
      heartbeatInterval: Number(
        process.env.KAFKA_HEARTBEAT_INTERVAL ??
          KAFKA_TIMING_DEFAULTS.heartbeatInterval,
      ),
      maxBytes,
      minBytes,
      maxWaitTime: Number(
        process.env.KAFKA_MAX_WAIT_TIME ?? KAFKA_TIMING_DEFAULTS.maxWaitTime,
      ),
      retry: {
        retries: parseInt(process.env.KAFKA_RETRY_ATTEMPTS || '5'),
        initialRetryTime: parseInt(
          process.env.KAFKA_INITIAL_RETRY_TIME || '100',
        ),
        maxRetryTime: parseInt(process.env.KAFKA_MAX_RETRY_TIME || '30000'),
      },
      dlq: {
        enabled: process.env.KAFKA_DLQ_ENABLED === 'true',
        topicSuffix: process.env.KAFKA_DLQ_TOPIC_SUFFIX || '.dlq',
        maxRetries: parseInt(process.env.KAFKA_DLQ_MAX_RETRIES || '3'),
      },
      disabled: process.env.DISABLE_KAFKA === 'true',
    };

    return this.register(kafkaOptions);
  }
}
