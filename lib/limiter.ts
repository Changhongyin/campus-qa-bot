/**
 * Per-IP rate limiter with rolling time windows.
 * Separate instances for upload and feedback tracking.
 */

interface WindowBuckets {
  hourBucket: number[];
  dayBucket: number[];
}

export class Limiter {
  private hourLimit: number;
  private dayLimit: number;
  private buckets = new Map<string, WindowBuckets>();
  private readonly hourMs = 60 * 60 * 1000;
  private readonly dayMs = 24 * 60 * 60 * 1000;

  constructor(hourLimit: number, dayLimit: number) {
    this.hourLimit = Math.max(1, hourLimit);
    this.dayLimit = Math.max(1, dayLimit);
  }

  check(ip: string): { allowed: boolean; resetMs?: number } {
    const now = Date.now();
    let buckets = this.buckets.get(ip);
    if (!buckets) {
      buckets = { hourBucket: [], dayBucket: [] };
      this.buckets.set(ip, buckets);
    }

    // Prune old entries
    buckets.hourBucket = buckets.hourBucket.filter((ts) => now - ts < this.hourMs);
    buckets.dayBucket = buckets.dayBucket.filter((ts) => now - ts < this.dayMs);

    // Check limits
    if (buckets.hourBucket.length >= this.hourLimit) {
      const oldestHour = buckets.hourBucket[0];
      const resetMs = Math.max(0, oldestHour + this.hourMs - now);
      return { allowed: false, resetMs };
    }

    if (buckets.dayBucket.length >= this.dayLimit) {
      const oldestDay = buckets.dayBucket[0];
      const resetMs = Math.max(0, oldestDay + this.dayMs - now);
      return { allowed: false, resetMs };
    }

    // Record this request
    buckets.hourBucket.push(now);
    buckets.dayBucket.push(now);
    return { allowed: true };
  }
}
