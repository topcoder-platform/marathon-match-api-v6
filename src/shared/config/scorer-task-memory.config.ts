/**
 * Default ECS scorer task memory in MiB. Matches the `memory` value used by the
 * `mm-ecs-runner` Fargate task definition revisions for every Marathon Match.
 */
export const DEFAULT_SCORER_TASK_MEMORY_MIB = 2048;

/**
 * Smallest task memory value Fargate accepts for any task CPU size.
 */
export const MIN_SCORER_TASK_MEMORY_MIB = 512;

/**
 * Largest task memory value Fargate accepts for any task CPU size.
 */
export const MAX_SCORER_TASK_MEMORY_MIB = 249856;

/**
 * Builds an inclusive list of memory values from `min` to `max`.
 * @param min First memory value in MiB.
 * @param max Last memory value in MiB.
 * @param step Increment between values in MiB.
 * @returns Memory values in ascending order.
 */
function buildMemoryRange(min: number, max: number, step: number): number[] {
  const values: number[] = [];
  for (let value = min; value <= max; value += step) {
    values.push(value);
  }
  return values;
}

/**
 * Fargate Linux task memory values (MiB) supported for each task CPU value.
 * Source: "Task CPU and memory" in the Amazon ECS developer guide.
 */
const FARGATE_TASK_MEMORY_BY_CPU: Readonly<Record<string, readonly number[]>> =
  {
    '256': [512, 1024, 2048],
    '512': buildMemoryRange(1024, 4096, 1024),
    '1024': buildMemoryRange(2048, 8192, 1024),
    '2048': buildMemoryRange(4096, 16384, 1024),
    '4096': buildMemoryRange(8192, 30720, 1024),
    '8192': buildMemoryRange(16384, 61440, 4096),
    '16384': buildMemoryRange(32768, 122880, 8192),
    '32768': [61440, 122880, 249856],
  };

/**
 * Formats supported memory values for validation messages. Evenly spaced values
 * are shown as a range so large CPU sizes stay readable.
 * @param values Supported memory values in ascending order.
 * @returns Human-readable description of the supported values.
 */
function describeMemoryValues(values: readonly number[]): string {
  const step = values.length > 2 ? values[1] - values[0] : undefined;
  const isEvenlySpaced =
    step !== undefined &&
    values.every(
      (value, index) => index === 0 || value - values[index - 1] === step,
    );

  if (isEvenlySpaced) {
    return `${values[0]} to ${values[values.length - 1]} MiB in ${step} MiB increments`;
  }

  return `${values.join(', ')} MiB`;
}

/**
 * Checks whether an ECS scorer task memory override is a valid Fargate size for
 * the task definition CPU. Used by marathon match config create/update so a bad
 * `memoryLimit` is rejected on save instead of failing every scorer launch.
 * @param memoryLimit Requested task memory in MiB.
 * @param taskCpu Task-level CPU units from the ECS task definition, for example `"1024"`.
 * @returns Validation error message, or `undefined` when the value is supported
 * or the CPU value is not a known Fargate size.
 */
export function getScorerTaskMemoryValidationError(
  memoryLimit: number,
  taskCpu: string | number,
): string | undefined {
  const normalizedCpu = String(taskCpu).trim();
  const supportedValues = FARGATE_TASK_MEMORY_BY_CPU[normalizedCpu];

  if (!supportedValues || supportedValues.includes(memoryLimit)) {
    return undefined;
  }

  return `memoryLimit ${memoryLimit} MiB is not supported by Fargate for a task with ${normalizedCpu} CPU units. Supported values: ${describeMemoryValues(supportedValues)}.`;
}
