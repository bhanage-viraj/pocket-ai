// Single-worker job queue: the phone runs one generation at a time.

export class QueueFullError extends Error {}

export function createQueue({ max = 5 } = {}) {
  const jobs = [];
  let running = false;

  async function drain() {
    if (running) return;
    running = true;
    while (jobs.length) {
      const job = jobs.shift();
      try {
        job.resolve(await job.fn());
      } catch (err) {
        job.reject(err);
      }
    }
    running = false;
  }

  return {
    /** Number of jobs waiting or running. */
    get size() {
      return jobs.length + (running ? 1 : 0);
    },
    /** Returns { position, done } — position = jobs ahead of this one. Throws QueueFullError. */
    push(fn) {
      const position = jobs.length + (running ? 1 : 0);
      if (position >= max) throw new QueueFullError(`queue full (${position})`);
      const done = new Promise((resolve, reject) => jobs.push({ fn, resolve, reject }));
      queueMicrotask(drain);
      return { position, done };
    },
  };
}
