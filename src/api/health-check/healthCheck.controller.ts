import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiProperty, ApiTags } from '@nestjs/swagger';
import { PrismaService } from 'src/shared/modules/global/prisma.service';

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
    example: 'Connected',
  })
  database: string;

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
  constructor(private readonly prisma: PrismaService) {}

  @Get('/health')
  @ApiOperation({ summary: 'Execute a health check' })
  async healthCheck(): Promise<GetHealthCheckResponseDto> {
    const response = new GetHealthCheckResponseDto();
    response.status = HealthCheckStatus.healthy;

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      response.database = 'connected';
    } catch (error) {
      console.error('Health check failed', error);
      response.status = HealthCheckStatus.unhealthy;
      response.database = 'disconnected';
      response.detail = 'Failed to connect to database';

      throw new ServiceUnavailableException(response);
    }

    return response;
  }
}
