import { Client } from 'pg';
import { withMemberScorerLock } from './member-scorer-lock';

jest.mock('pg', () => ({ Client: jest.fn() }));

describe('member scorer dispatch lock', () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let client: { connect: jest.Mock; query: jest.Mock; end: jest.Mock };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.DATABASE_URL = 'postgresql://localhost/scorer-lock-test';
    client = {
      connect: jest.fn().mockResolvedValue(undefined),
      query: jest.fn().mockResolvedValue({ rows: [] }),
      end: jest.fn().mockResolvedValue(undefined),
    };
    (Client as unknown as jest.Mock).mockImplementation(() => client);
  });
  afterEach(() => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it('waits for the database lock before dispatch and closes its session afterwards', async () => {
    const events: string[] = [];
    client.query.mockImplementation(async () => {
      events.push('lock');
    });
    client.end.mockImplementation(async () => {
      events.push('release');
    });
    const result = await withMemberScorerLock(
      'challenge-1',
      'member-1',
      async () => {
        events.push('dispatch');
        return 'new-task';
      },
    );
    expect(result).toBe('new-task');
    expect(events).toEqual(['lock', 'dispatch', 'release']);
    expect(client.query).toHaveBeenCalledWith(
      'SELECT pg_advisory_lock($1::integer, $2::integer)',
      [expect.any(Number), expect.any(Number)],
    );
  });

  it('shares keys across replicas for the same member without locking unrelated members', async () => {
    await withMemberScorerLock(
      'challenge-1',
      'member-1',
      async () => undefined,
    );
    await withMemberScorerLock(
      'challenge-1',
      'member-1',
      async () => undefined,
    );
    await withMemberScorerLock(
      'challenge-1',
      'member-2',
      async () => undefined,
    );
    await withMemberScorerLock(
      'challenge-2',
      'member-1',
      async () => undefined,
    );
    const keys = client.query.mock.calls.map((call) => call[1]);
    expect(keys[0]).toEqual(keys[1]);
    expect(keys[0]).not.toEqual(keys[2]);
    expect(keys[0]).not.toEqual(keys[3]);
  });

  it.each(['connect', 'query'])(
    'fails closed when %s fails',
    async (operation) => {
      client[operation as 'connect' | 'query'].mockRejectedValue(
        new Error('database unavailable'),
      );
      const work = jest.fn();
      await expect(
        withMemberScorerLock('challenge', 'member', work),
      ).rejects.toThrow('database unavailable');
      expect(work).not.toHaveBeenCalled();
      expect(client.end).toHaveBeenCalledTimes(1);
    },
  );

  it('releases the member after failed dispatch so the newer event can retry', async () => {
    await expect(
      withMemberScorerLock('challenge', 'member', async () => {
        throw new Error('ECS unavailable');
      }),
    ).rejects.toThrow('ECS unavailable');
    expect(client.end).toHaveBeenCalledTimes(1);
    await expect(
      withMemberScorerLock('challenge', 'member', async () => 'retry'),
    ).resolves.toBe('retry');
  });
});
