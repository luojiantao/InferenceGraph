import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentId, SearchStrategy } from '@reasoner/schema';
import { ReasonerService } from '@reasoner/core';
import { createStorage, systemClock, uuidIdGenerator } from '@reasoner/storage';
import {
  ReasonerTestAgent,
  ReplayFixtureSchema,
  type ReplayFixture,
  type ReplayReport,
} from './reasoner-test-agent.js';

/** Loads and validates the bundled BD1 fixture from disk. */
export const loadBd1Fixture = (): ReplayFixture => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, 'fixtures', 'bd1.json'),
    join(here, '..', 'src', 'fixtures', 'bd1.json'),
  ]) {
    try {
      return ReplayFixtureSchema.parse(JSON.parse(readFileSync(candidate, 'utf8')));
    } catch (cause) {
      if (cause instanceof Error && cause.message.includes('ENOENT')) continue;
      throw cause;
    }
  }
  throw new Error('could not locate fixtures/bd1.json');
};

export interface Bd1ReplayOptions {
  readonly strategy?: SearchStrategy;
  /** ':memory:' keeps the replay entirely in-process. */
  readonly dataDir?: string;
}

/**
 * Runs the BD1 fixture end to end against a fresh in-memory store. Touches no
 * network and no external system: everything comes from the bundled JSON.
 */
export const runBd1Replay = async (options: Bd1ReplayOptions = {}): Promise<ReplayReport> => {
  const fixture = loadBd1Fixture();
  const storage = createStorage({
    dataDir: options.dataDir ?? ':memory:',
    clock: systemClock,
    enableAudit: false,
  });

  try {
    const service = new ReasonerService({
      repository: storage.repository,
      clock: systemClock,
      ids: uuidIdGenerator,
      audit: storage.audit,
    });
    const agent = new ReasonerTestAgent(service, 'bd1-replay-agent' as AgentId);
    return await agent.runSession(fixture, options.strategy ?? 'DFS');
  } finally {
    storage.close();
  }
};
