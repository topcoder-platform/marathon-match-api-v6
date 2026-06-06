import { readFileSync } from 'fs';
import { join } from 'path';

describe('ECS runner regression fixtures', () => {
  it('includes the Issue #23 Java compile workspace regression submission', () => {
    const repoRoot = join(__dirname, '..');
    const fixtureDir = join(repoRoot, 'scripts/fixtures/Blocks');
    const manifest = JSON.parse(
      readFileSync(join(fixtureDir, 'marathon-match-test.json'), 'utf8'),
    );

    const submission = manifest.submissions.find(
      (entry) => entry.source?.issue === 23,
    );

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
});
