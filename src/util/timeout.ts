/**
 * Wraps a promise with a timeout. Throws if the promise doesn't resolve within `ms` milliseconds.
 */
export async function withTimeout<T>(fn: () => Promise<T>, ms: number, label?: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label ?? `Timed out after ${ms}ms`)), ms);
  });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return await Promise.race([fn() as any, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
