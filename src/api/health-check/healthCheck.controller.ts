import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PrismaService } from 'src/shared/modules/global/prisma.service';
import {
  KafkaConnectionState,
  KafkaConsumerService,
} from 'src/shared/modules/kafka/kafka-consumer.service';

export enum HealthCheckStatus {
  healthy = 'healthy',
  unhealthy = 'unhealthy',
}

export class GetHealthCheckResponseDto {
  @ApiProperty({
    description: 'The status of the health check',
    enum: HealthCheckStatus,
    example: HealthCheckStatus.healthy,
  })
  status: HealthCheckStatus;

  @ApiProperty({
    description: 'Database connection status',
    example: 'connected',
  })
  database: string;

  @ApiProperty({
    description: 'Kafka consumer connection status',
    enum: KafkaConnectionState,
    example: KafkaConnectionState.ready,
  })
  kafka: KafkaConnectionState;

  @ApiProperty({
    description: 'Current Kafka consumer reconnect attempt count',
    example: 0,
  })
  kafkaReconnectAttempts: number;

  @ApiProperty({
    description: 'Additional detail describing an unhealthy dependency',
    required: false,
    example: 'Failed to connect to database',
  })
  detail?: string;
}

@ApiTags('Healthcheck')
@Controller()
export class HealthCheckController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly kafkaConsumerService: KafkaConsumerService,
  ) {}

  @Get('/health')
  @ApiOperation({ summary: 'Execute a health check' })
  async healthCheck(): Promise<GetHealthCheckResponseDto> {
    const response = new GetHealthCheckResponseDto();
    response.status = HealthCheckStatus.healthy;
    const unhealthyDetails: string[] = [];

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      response.database = 'connected';
    } catch (error) {
      console.error('Health check failed', error);
      response.status = HealthCheckStatus.unhealthy;
      response.database = 'disconnected';
      unhealthyDetails.push('Failed to connect to database');
    }

    const kafkaStatus = this.kafkaConsumerService.getKafkaStatus();
    response.kafka = kafkaStatus.state;
    response.kafkaReconnectAttempts = kafkaStatus.reconnectAttempts;

    if (kafkaStatus.state !== KafkaConnectionState.ready) {
      response.status = HealthCheckStatus.unhealthy;
      unhealthyDetails.push(
        kafkaStatus.reason
          ? `Kafka consumer is ${kafkaStatus.state}: ${kafkaStatus.reason}`
          : `Kafka consumer is ${kafkaStatus.state}`,
      );
    }

    if (response.status === HealthCheckStatus.unhealthy) {
      response.detail = unhealthyDetails.join('; ');
      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
