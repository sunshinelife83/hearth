import type { Request, Response, NextFunction } from "express";
import { requestIp } from "./logger.js";

export interface RateLimitRule {
  /** Maximum actions allowed per window per key. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
}

export interface RateLimitOptions {
  keyPrefix: string;
  rule: RateLimitRule;
}

interface Bucket {
  hits: number[];
}

/**
 * Small in-memory sliding-window limiter. State is per-process by design:
 * Hearth runs as a single local server process, so this needs no shared
 * store. Keys that go idle are evicted lazily to keep the map bounded.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private lastSweep = 0;

  constructor(private readonly options: RateLimitOptions) {}

  take(key: string, now = Date.now()): { allowed: boolean; retryAfterSeconds: number } {
    this.sweep(now);
    const bucketKey = `${this.options.keyPrefix}:${key}`;
    const bucket = this.buckets.get(bucketKey) ?? { hits: [] };
    const cutoff = now - this.options.rule.windowMs;
    bucket.hits = bucket.hits.filter((hit) => hit > cutoff);

    if (bucket.hits.length >= this.options.rule.limit) {
      const oldest = bucket.hits[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + this.options.rule.windowMs - now) / 1000));
      this.buckets.set(bucketKey, bucket);
      return { allowed: false, retryAfterSeconds };
    }

    bucket.hits.push(now);
    this.buckets.set(bucketKey, bucket);
    return { allowed: true, retryAfterSeconds: 0 };
  }

  /** Successful authorizations reset the failure window for the key. */
  reset(key: string): void {
    this.buckets.delete(`${this.options.keyPrefix}:${key}`);
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < 60_000 && this.buckets.size < 10_000) return;
    this.lastSweep = now;
    const cutoff = now - this.options.rule.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (!bucket.hits.some((hit) => hit > cutoff)) this.buckets.delete(key);
    }
  }
}

export function ipRateLimitMiddleware(limiter: RateLimiter, trustProxy: boolean): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    const ip = requestIp(req, trustProxy) ?? "unknown";
    const result = limiter.take(ip);
    if (result.allowed) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(result.retryAfterSeconds));
    res.status(429).json({
      error: "rate_limited",
      error_description: "Too many requests. Try again later.",
    });
  };
}

export interface AuthRateLimitConfig {
  authorizeRule: RateLimitRule;
  registerRule: RateLimitRule;
  tokenRule: RateLimitRule;
}

export const DEFAULT_AUTH_RATE_LIMITS: AuthRateLimitConfig = {
  authorizeRule: { limit: 20, windowMs: 60 * 60 * 1000 },
  registerRule: { limit: 30, windowMs: 60 * 60 * 1000 },
  tokenRule: { limit: 120, windowMs: 60 * 60 * 1000 },
};

export function createAuthRateLimiters(trustProxy: boolean, config: AuthRateLimitConfig = DEFAULT_AUTH_RATE_LIMITS): {
  authorizeLimiter: RateLimiter;
  registerLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
  authorizeIpMiddleware: ReturnType<typeof ipRateLimitMiddleware>;
  registerIpMiddleware: ReturnType<typeof ipRateLimitMiddleware>;
  tokenIpMiddleware: ReturnType<typeof ipRateLimitMiddleware>;
} {
  const authorizeLimiter = new RateLimiter({ keyPrefix: "authorize", rule: config.authorizeRule });
  const registerLimiter = new RateLimiter({ keyPrefix: "register", rule: config.registerRule });
  const tokenLimiter = new RateLimiter({ keyPrefix: "token", rule: config.tokenRule });
  return {
    authorizeLimiter,
    registerLimiter,
    tokenLimiter,
    authorizeIpMiddleware: ipRateLimitMiddleware(authorizeLimiter, trustProxy),
    registerIpMiddleware: ipRateLimitMiddleware(registerLimiter, trustProxy),
    tokenIpMiddleware: ipRateLimitMiddleware(tokenLimiter, trustProxy),
  };
}
