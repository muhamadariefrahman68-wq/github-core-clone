// scenario.ts — recompute the scenario viewer identity from the fixed
// scenario seed, vendoring the exact RNG + user generation from the kit's
// program/env/src/wire.ts (no network, no git binary, stdlib only).
// The scenario is identical across every instance; only the trial seed/now
// vary. The viewer login is derived, never hard-coded.

export const SCENARIO_SEED = 0x6a09e667f3bcc909n;
export const SCENARIO_EPOCH_SEC = 1735689600;

const U64_MASK = (1n << 64n) - 1n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: a seeded value with every bit mixed into every other. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: a stable function of SCENARIO_SEED and the label. */
function scenarioSeedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: a 64-bit state walked by three shifts and one multiply. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)];
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;

const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

export interface ScenarioUser {
  id: number;
  login: string;
  name: string;
  email: string;
}

export interface ScenarioOrg {
  id: number;
  login: string;
  name: string;
}

export interface ScenarioRepo {
  id: number;
  name: string;
  description: string;
  private: boolean;
  defaultBranch: string;
}

function generateUsers(rng: Rng, count: number): ScenarioUser[] {
  const used = new Set<string>();
  const users: ScenarioUser[] = [];
  for (let i = 0; i < count; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`;
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    users.push({ id: 1000 + i, login, name: `${first} ${last}`, email: `${login}@example.invalid` });
  }
  return users;
}

export interface Scenario {
  viewer: ScenarioUser;
  users: ScenarioUser[];
  org: ScenarioOrg;
  repos: ScenarioRepo[];
}

export function buildScenario(): Scenario {
  const users = generateUsers(new Rng(scenarioSeedFor('users')), 12);
  const org = { id: 2000, login: 'faint-meadow-org', name: 'Faint Meadow Org' };
  const repos: ScenarioRepo[] = [
    { id: 5000, name: 'amber-thistle', description: 'the tooling behind the thing', private: false, defaultBranch: 'main' },
    { id: 5001, name: 'cinder-fox', description: 'an experimental build pipeline', private: false, defaultBranch: 'main' },
    { id: 5002, name: 'harbor-lantern', description: 'notes, sketches, and tiny utilities', private: false, defaultBranch: 'main' },
    { id: 5003, name: 'quiet-ember', description: 'a place to keep things that matter', private: false, defaultBranch: 'main' },
    { id: 5004, name: 'velvet-orbit', description: 'explorations in small interfaces', private: false, defaultBranch: 'main' },
  ];
  return { viewer: users[0], users, org, repos };
}

export const SCENARIO: Scenario = buildScenario();
