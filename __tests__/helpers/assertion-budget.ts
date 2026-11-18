/**
 * A test that makes more expect() calls than this is paying about 30 µs per call;
 * collect the per-element checks and assert once (DEVELOPMENT-PLAN §7, Test runtime).
 * Loaded for every test file through `setupFilesAfterEnv`.
 */
export const MAX_ASSERTIONS_PER_TEST = 5000;

export function checkAssertionCount(n: number): void {
  if (n > MAX_ASSERTIONS_PER_TEST) {
    throw new Error(
      `${n} expect() calls in one test (limit ${MAX_ASSERTIONS_PER_TEST}); collect ` +
        "per-element checks and assert once (DEVELOPMENT-PLAN §7, Test runtime)"
    );
  }
}

// jest-circus resets the count at test_done, after the afterEach hooks, so this
// sees the whole test's calls.
afterEach(() => checkAssertionCount(expect.getState().assertionCalls));
