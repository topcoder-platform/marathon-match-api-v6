import { BadRequestException, ConflictException } from '@nestjs/common';
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
      enqueueCompilation: jest.fn().mockResolvedValue(undefined),
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

  it('returns compilation errors in tester details', async () => {
    const { service, prisma } = createService();
    const compilationError = 'Tester.java:12: error: cannot find symbol';

    prisma.tester.findUnique.mockResolvedValue({
      ...testerRecord,
      compilationStatus: CompilationStatus.FAILED,
      compilationError,
    });

    const result = await service.getTester('tester-1');

    expect(result.compilationStatus).toBe(CompilationStatus.FAILED);
    expect(result.compilationError).toBe(compilationError);
    expect(prisma.tester.findUnique).toHaveBeenCalledWith({
      where: { id: 'tester-1' },
      select: expect.objectContaining({
        compilationError: true,
        compilationStatus: true,
        sourceCode: true,
      }),
    });
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

  it('returns compilation errors when listing testers', async () => {
    const { service, prisma } = createService();
    const compilationError = 'Tester.java:12: error: cannot find symbol';
    const testerSummary = {
      id: testerRecord.id,
      name: testerRecord.name,
      version: testerRecord.version,
      className: testerRecord.className,
      compilationStatus: CompilationStatus.FAILED,
      compilationError,
      createdAt: testerRecord.createdAt,
      updatedAt: testerRecord.updatedAt,
      createdBy: testerRecord.createdBy,
      updatedBy: testerRecord.updatedBy,
    };

    prisma.tester.findMany.mockResolvedValue([testerSummary]);
    prisma.tester.count.mockResolvedValue(1);

    const result = await service.listTesters({
      page: 1,
      perPage: 20,
    } as never);

    expect(result.testers).toEqual([testerSummary]);
    expect(prisma.tester.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          compilationError: true,
          compilationStatus: true,
        }),
      }),
    );
  });

  it('rejects creating a tester family when the tester name already exists', async () => {
    const { service, prisma, testerCompilationService } = createService();

    prisma.tester.findMany.mockResolvedValue([
      { version: '1.0.0' },
      { version: '1.0.3' },
    ]);

    await expect(
      service.createTester(
        {
          name: testerRecord.name,
          version: '1.0.4',
          sourceCode: 'public class BridgeRunnersTesterV4 {}',
          className: 'com.topcoder.BridgeRunnersTesterV4',
        },
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(prisma.tester.findMany).toHaveBeenCalledWith({
      where: {
        name: testerRecord.name,
      },
      select: {
        version: true,
      },
    });
    expect(prisma.tester.create).not.toHaveBeenCalled();
    expect(testerCompilationService.enqueueCompilation).not.toHaveBeenCalled();
  });

  it('creates a new tester version and omits jar data by default', async () => {
    const { service, prisma, testerCompilationService } = createService();

    prisma.tester.findUnique.mockResolvedValue({
      id: testerRecord.id,
      name: testerRecord.name,
      version: testerRecord.version,
      className: testerRecord.className,
      sourceCode: testerRecord.sourceCode,
    });
    prisma.tester.findMany.mockResolvedValue([
      { version: '1.0.0' },
      { version: '1.0.1' },
    ]);
    prisma.tester.create.mockResolvedValue({
      ...testerRecord,
      id: 'generated-id',
      version: '1.0.2',
      sourceCode: 'public class BridgeRunnersTesterV2 {}',
      className: 'com.topcoder.BridgeRunnersTesterV2',
      compilationStatus: CompilationStatus.PENDING,
      createdBy: '40051399',
      updatedBy: '40051399',
    });

    const result = await service.createTesterVersion(
      'tester-1',
      {
        sourceCode: 'public class BridgeRunnersTesterV2 {}',
        version: '1.0.2',
        className: 'com.topcoder.BridgeRunnersTesterV2',
      },
      {
        isMachine: false,
        userId: '40051399',
      } as never,
    );

    expect(result).toEqual({
      compilationTriggered: true,
      tester: {
        ...testerRecord,
        id: 'generated-id',
        version: '1.0.2',
        sourceCode: 'public class BridgeRunnersTesterV2 {}',
        className: 'com.topcoder.BridgeRunnersTesterV2',
        compilationStatus: CompilationStatus.PENDING,
        createdBy: '40051399',
        updatedBy: '40051399',
        jarFile: null,
      },
    });
    expect(prisma.tester.findUnique).toHaveBeenCalledWith({
      where: { id: 'tester-1' },
      select: {
        id: true,
        name: true,
        version: true,
        className: true,
        sourceCode: true,
      },
    });
    expect(prisma.tester.findMany).toHaveBeenCalledWith({
      where: {
        name: testerRecord.name,
      },
      select: {
        version: true,
      },
    });
    expect(prisma.tester.create.mock.calls[0][0].select).not.toHaveProperty(
      'jarFile',
    );
    expect(prisma.tester.update).not.toHaveBeenCalled();
    expect(testerCompilationService.enqueueCompilation).toHaveBeenCalledWith(
      'generated-id',
      'public class BridgeRunnersTesterV2 {}',
    );
  });

  it('rejects versions that are not higher than the current max tester version', async () => {
    const { service, prisma, testerCompilationService } = createService();

    prisma.tester.findUnique.mockResolvedValue({
      id: testerRecord.id,
      name: testerRecord.name,
      version: testerRecord.version,
      className: testerRecord.className,
      sourceCode: testerRecord.sourceCode,
    });
    prisma.tester.findMany.mockResolvedValue([
      { version: '1.0.0' },
      { version: '1.0.10' },
    ]);

    await expect(
      service.createTesterVersion(
        'tester-1',
        {
          sourceCode: 'public class BridgeRunnersTesterV2 {}',
          version: '1.0.2',
          className: 'com.topcoder.BridgeRunnersTesterV2',
        },
        {
          isMachine: false,
          userId: '40051399',
        } as never,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.tester.create).not.toHaveBeenCalled();
    expect(prisma.tester.update).not.toHaveBeenCalled();
    expect(testerCompilationService.enqueueCompilation).not.toHaveBeenCalled();
  });
});
