import { rm } from "node:fs/promises";

/**
 * Remove a test fixture directory, tolerating Windows file locks.
 *
 * Windows keeps an OS lock on open SQLite files (EBUSY/EPERM/ENOTEMPTY on
 * rm). All fixture stores must be closed before this runs, but the OS can
 * hold the lock briefly after close, so retry with backoff. POSIX deletes
 * open files fine, so this is a no-op fast path there.
 */
export async function rmFixtureDir(root: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    try {
      await rm(root, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
  throw lastError;
}
