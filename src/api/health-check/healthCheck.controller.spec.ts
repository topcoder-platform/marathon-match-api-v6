jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));
jest.mock('src/shared/modules/kafka/kafka-consumer.service', () => ({
  KafkaConnectionState: {
    disabled: 'disabled',
    initializing: 'initializing',
    ready: 'ready',
    reconnecting: 'reconnecting',
    failed: 'failed',
  },
  KafkaConsumerService: class KafkaConsumerService {},
}));

import {
  HealthCheckController,
  HealthCheckStatus,
} from './healthCheck.controller';
import { KafkaConnectionState } from 'src/shared/modules/kafka/kafka-consumer.service';

describe('HealthCheckController', () => {
  const createController = (
    prismaQuery: jest.Mock,
    kafkaState: KafkaConnectionState,
    kafkaReason?: string,
  ): HealthCheckController => {
    return new HealthCheckController(
      { $queryRaw: prismaQuery } as never,
      {
        getKafkaStatus: jest.fn().mockReturnValue({
          state: kafkaState,
          reconnectAttempts: 0,
          reason: kafkaReason,
        }),
      } as never,
    );
  };

  it('reports healthy when database and Kafka are ready', async () => {
    const controller = createController(
      jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      KafkaConnectionState.ready,
    );

    await expect(controller.healthCheck()).resolves.toEqual({
      status: HealthCheckStatus.healthy,
      database: 'connected',
      kafka: KafkaConnectionState.ready,
      kafkaReconnectAttempts: 0,
    });
  });

  it('reports unhealthy when Kafka is not ready', async () => {
    const controller = createController(
      jest.fn().mockResolvedValue([{ '?column?': 1 }]),
      KafkaConnectionState.failed,
      'Kafka reconnection attempts exhausted',
    );

    await expect(controller.healthCheck()).rejects.toMatchObject({
      response: expect.objectContaining({
        status: HealthCheckStatus.unhealthy,
        database: 'connected',
        kafka: KafkaConnectionState.failed,
        kafkaReconnectAttempts: 0,
        detail:
          'Kafka consumer is failed: Kafka reconnection attempts exhausted',
      }),
    });
  });
});
