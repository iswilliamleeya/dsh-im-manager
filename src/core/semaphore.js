/** Minimal counting semaphore for bounding concurrent agent turns. */

/**
 * @param {number} max
 */
export function createSemaphore(max) {
  const capacity = Math.max(1, Math.floor(max));
  let active = 0;
  /** @type {Array<() => void>} */
  const waiters = [];
  let peak = 0;

  /** @returns {Promise<void>} */
  function acquire() {
    if (active < capacity) {
      active += 1;
      peak = Math.max(peak, active);
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      waiters.push(() => {
        active += 1;
        peak = Math.max(peak, active);
        resolve();
      });
    });
  }

  function release() {
    active = Math.max(0, active - 1);
    const next = waiters.shift();
    if (next !== undefined) next();
  }

  return {
    acquire,
    release,
    get active() {
      return active;
    },
    get queued() {
      return waiters.length;
    },
    get peak() {
      return peak;
    },
    get capacity() {
      return capacity;
    },
  };
}
