import { CompilationStatus } from '@prisma/client';
import { LoggerService } from 'src/shared/modules/global/logger.service';

jest.mock('nanoid', () => ({
  nanoid: jest.fn(() => 'generated-id'),
}));

import { TesterService } from './tester.service';

describe('TesterService', () => {
  const mockLogger = {
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  };

  const testerRecord = {
    id: 'tester-1',
    name: 'Bridge Runners',
    version: '1.0.0',
    className: 'com.topcoder.BridgeRunnersTester',
    sourceCode: 'public class BridgeRunnersTester {}',
    compilationStatus: CompilationStatus.SUCCESS,
    compilationError: null,
    createdAt: new Date('2026-03-01T00:00:00.000Z'),
    updatedAt: new Date('2026-03-02T00:00:00.000Z'),
    createdBy: '40051399',
    updatedBy: '40051399',
  };

  const createService = () => {
    const prisma = {
      tester: {
        findUnique: jest.fn(),
        update: jest.fn(),
        create: jest.fn(),
        delete: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    const prismaErrorService = {
      handleError: jest.fn(),
    };
    const testerCompilationService = {
      enqueueCompilation: jest.fn(),
    };

    jest.spyOn(LoggerService, 'forRoot').mockReturnValue(mockLogger as never);

    const service = new TesterService(
      prisma as never,
      prismaErrorService as never,
      testerCompilationService as never,
    );

    return {
      service,
      prisma,
      testerCompilationService,
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('returns tester details without jar data by default', async () => {
    const { service, prisma } = createService();

    prisma.tester.findUnique.mockResolvedValue(testerRecord);

    const result = await service.getTester('tester-1');

    expect(result).toEqual({
      ...testerRecord,
      jarFile: null,
    });
    expect(prisma.tester.findUnique).toHaveBeenCalledWith({
      where: { id: 'tester-1' },
      select: expect.objectContaining({
        sourceCode: true,
      }),
    });
    expect(prisma.tester.findUnique.mock.calls[0][0].select).not.toHaveProperty(
      'jarFile',
    );
  });

  it('returns base64 jar data only when explicitly requested', async () => {
    const { service, prisma } = createService();

    prisma.tester.findUnique.mockResolvedValue({
      ...testerRecord,
      jarFile: Uint8Array.from(Buffer.from('compiled-jar')),
    });

    const result = await service.getTester('tester-1', true);

    expect(result.jarFile).toBe(Buffer.from('compiled-jar').toString('base64'));
    expect(prisma.tester.findUnique).toHaveBeenCalledWith({
      where: { id: 'tester-1' },
      select: expect.objectContaining({
        jarFile: true,
        sourceCode: true,
      }),
    });
  });

  it('omits jar data from update responses unless explicitly requested', async () => {
    const { service, prisma, testerCompilationService } = createService();

    prisma.tester.findUnique.mockResolvedValue({
      sourceCode: testerRecord.sourceCode,
    });
    prisma.tester.update.mockResolvedValue({
      ...testerRecord,
      version: '1.0.1',
    });

    const result = await service.updateTester(
      'tester-1',
      {
        sourceCode: testerRecord.sourceCode,
        version: '1.0.1',
      },
      {
        isMachine: false,
        userId: '40051399',
      } as never,
    );

    expect(result).toEqual({
      compilationTriggered: false,
      tester: {
        ...testerRecord,
        version: '1.0.1',
        jarFile: null,
      },
    });
    expect(prisma.tester.findUnique).toHaveBeenCalledWith({
      where: { id: 'tester-1' },
      select: {
        sourceCode: true,
      },
    });
    expect(prisma.tester.update.mock.calls[0][0].select).not.toHaveProperty(
      'jarFile',
    );
    expect(testerCompilationService.enqueueCompilation).not.toHaveBeenCalled();
  });
});
