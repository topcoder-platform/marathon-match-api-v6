import { getScorerTaskMemoryValidationError } from './scorer-task-memory.config';

describe('scorer task memory configuration', () => {
  it('accepts Fargate-supported memory values for the task CPU', () => {
    expect(getScorerTaskMemoryValidationError(2048, '1024')).toBeUndefined();
    expect(getScorerTaskMemoryValidationError(8192, '1024')).toBeUndefined();
    expect(getScorerTaskMemoryValidationError(512, 256)).toBeUndefined();
    expect(getScorerTaskMemoryValidationError(65536, '16384')).toBeUndefined();
  });

  it('rejects memory values that Fargate does not support for the task CPU', () => {
    expect(getScorerTaskMemoryValidationError(3000, '1024')).toBe(
      'memoryLimit 3000 MiB is not supported by Fargate for a task with 1024 CPU units. Supported values: 2048 to 8192 MiB in 1024 MiB increments.',
    );
    expect(getScorerTaskMemoryValidationError(1024, ' 1024 ')).toContain(
      'Supported values: 2048 to 8192 MiB',
    );
    expect(getScorerTaskMemoryValidationError(4096, '256')).toBe(
      'memoryLimit 4096 MiB is not supported by Fargate for a task with 256 CPU units. Supported values: 512, 1024, 2048 MiB.',
    );
  });

  it('skips validation for CPU values that are not Fargate task sizes', () => {
    expect(getScorerTaskMemoryValidationError(3000, '1536')).toBeUndefined();
  });
});
