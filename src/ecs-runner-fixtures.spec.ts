import { readFileSync } from 'fs';
import { join } from 'path';

interface FixtureManifest {
  submissions: Array<{ file: string; source?: Record<string, unknown> }>;
}

describe('ECS runner regression fixtures', () => {
  const repoRoot = join(__dirname, '..');
  const fixtureDir = join(repoRoot, 'scripts/fixtures/Blocks');

  function readFixtureManifest(): FixtureManifest {
    const manifest = JSON.parse(
      readFileSync(join(fixtureDir, 'marathon-match-test.json'), 'utf8'),
    ) as FixtureManifest;

    return manifest;
  }

  it('includes the Issue #23 Java compile workspace regression submission', () => {
    const manifest = readFixtureManifest();

    const submission = manifest.submissions.find(
      (entry) => entry.source?.issue === 23,
    );

    expect(submission).toBeDefined();
    if (!submission) {
      throw new Error('Missing Issue #23 Java fixture submission.');
    }

    expect(submission).toEqual(
      expect.objectContaining({
        file: 'submissions/submission-issue-23-java-workdir-lifetime.zip',
        source: expect.objectContaining({
          language: 'java',
          issue: 23,
        }),
      }),
    );

    const zipBytes = readFileSync(join(fixtureDir, submission.file));
    expect(Array.from(zipBytes.subarray(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
    expect(zipBytes.includes(Buffer.from('BlockGame.java'))).toBe(true);
  });

  it('includes timeout validation submissions around a 100 ms measured window', () => {
    const manifest = readFixtureManifest();

    for (const fixture of [
      {
        file: 'submissions/submission-timeout-under-limit.zip',
        expectedText:
          'With testTimeout=100 ms this should complete successfully.',
      },
      {
        file: 'submissions/submission-timeout-over-limit.zip',
        expectedText: 'With testTimeout=100 ms this should fail',
      },
    ]) {
      const submission = manifest.submissions.find(
        (entry) => entry.file === fixture.file,
      );

      expect(submission).toBeDefined();
      if (!submission) {
        throw new Error(`Missing timeout fixture submission: ${fixture.file}`);
      }

      expect(submission).toEqual(
        expect.objectContaining({
          file: fixture.file,
          source: expect.objectContaining({
            language: 'cpp',
            purpose: expect.stringContaining(fixture.expectedText),
          }),
        }),
      );

      const zipBytes = readFileSync(join(fixtureDir, fixture.file));
      expect(Array.from(zipBytes.subarray(0, 4))).toEqual([0x50, 0x4b, 3, 4]);
      expect(zipBytes.includes(Buffer.from('BlockGame.cpp'))).toBe(true);
    }
  });
});
