import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

jest.mock('src/shared/modules/global/ecs.service', () => ({
  EcsService: class EcsService {},
}));

jest.mock('src/shared/modules/global/m2m.service', () => ({
  M2MService: class M2MService {},
}));

jest.mock('src/shared/modules/global/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { ScoringResultController } from './scoring-result.controller';
import { ScoringResultService } from './scoring-result.service';

describe('ScoringResultController Swagger', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const moduleRef: TestingModule = await Test.createTestingModule({
      controllers: [ScoringResultController],
      providers: [
        {
          provide: ScoringResultService,
          useValue: {
            processScoringProgress: jest.fn(),
            processScoringResult: jest.fn(),
            triggerSystemScore: jest.fn(),
          },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('/v6/marathon-match');
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('documents the scoring-results request body fields', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1.0').build(),
    );

    const scoringResultsPath =
      document.paths['/v6/marathon-match/internal/scoring-results'];

    expect(scoringResultsPath?.post).toBeDefined();

    const scoringResultsPost = scoringResultsPath?.post as any;
    const requestSchemaRef =
      scoringResultsPost.requestBody.content['application/json'].schema.$ref;
    const requestSchemaName = requestSchemaRef.split('/').pop();
    const requestSchema = document.components?.schemas?.[
      requestSchemaName ?? ''
    ] as any;

    expect(requestSchema.properties).toEqual(
      expect.objectContaining({
        challengeId: expect.objectContaining({ type: 'string' }),
        submissionId: expect.objectContaining({ type: 'string' }),
        score: expect.objectContaining({ type: 'number' }),
        testPhase: expect.objectContaining({ type: 'string' }),
        reviewTypeId: expect.objectContaining({ type: 'string' }),
        reviewId: expect.objectContaining({ type: 'string' }),
        scorecardId: expect.objectContaining({ type: 'string' }),
        metadata: expect.objectContaining({ type: 'object' }),
        currentReview: expect.objectContaining({ type: 'object' }),
        impactedReviews: expect.objectContaining({ type: 'array' }),
      }),
    );
    expect(requestSchema.required).toEqual(
      expect.arrayContaining([
        'challengeId',
        'submissionId',
        'score',
        'testPhase',
        'reviewTypeId',
      ]),
    );
  });

  it('documents the scoring-progress request body fields', () => {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Test').setVersion('1.0').build(),
    );

    const scoringProgressPath =
      document.paths['/v6/marathon-match/internal/scoring-progress'];

    expect(scoringProgressPath?.post).toBeDefined();

    const scoringProgressPost = scoringProgressPath?.post as any;
    const requestSchemaRef =
      scoringProgressPost.requestBody.content['application/json'].schema.$ref;
    const requestSchemaName = requestSchemaRef.split('/').pop();
    const requestSchema = document.components?.schemas?.[
      requestSchemaName ?? ''
    ] as any;

    expect(requestSchema.properties).toEqual(
      expect.objectContaining({
        challengeId: expect.objectContaining({ type: 'string' }),
        submissionId: expect.objectContaining({ type: 'string' }),
        testPhase: expect.objectContaining({ type: 'string' }),
        reviewTypeId: expect.objectContaining({ type: 'string' }),
        progress: expect.objectContaining({ type: 'number' }),
        status: expect.objectContaining({ enum: expect.any(Array) }),
        completedTests: expect.objectContaining({ type: 'number' }),
        totalTests: expect.objectContaining({ type: 'number' }),
        failedTests: expect.objectContaining({ type: 'number' }),
        metadata: expect.objectContaining({ type: 'object' }),
      }),
    );
    expect(requestSchema.required).toEqual(
      expect.arrayContaining([
        'challengeId',
        'submissionId',
        'testPhase',
        'reviewTypeId',
        'progress',
        'status',
      ]),
    );
  });
});
