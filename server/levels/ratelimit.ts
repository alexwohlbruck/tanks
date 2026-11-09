// Per-IP token buckets (in memory; one server process).

type Bucket = { tokens: number; at: number }

export class RateLimit {
  private buckets = new Map<string, Bucket>()

  /** `burst` requests at once, refilled at `perMinute` */
  constructor(private burst: number, private perMinute: number) {}

  /** true when the request may go ahead */
  take(key: string, cost = 1): boolean {
    const now = Date.now()
    let b = this.buckets.get(key)
    if (!b) {
      b = { tokens: this.burst, at: now }
      this.buckets.set(key, b)
    }
    b.tokens = Math.min(this.burst, b.tokens + ((now - b.at) / 60000) * this.perMinute)
    b.at = now
    if (this.buckets.size > 10000) this.sweep(now)
    if (b.tokens < cost) return false
    b.tokens -= cost
    return true
  }

  private sweep(now: number) {
    for (const [k, b] of this.buckets) if (now - b.at > 10 * 60000) this.buckets.delete(k)
  }
}

/** client address: the reverse proxy's X-Forwarded-For, else the socket peer */
export function clientIp(req: Request, server: { requestIP(r: Request): { address: string } | null }): string {
  const fwd = req.headers.get('x-forwarded-for')
  if (fwd) return fwd.split(',')[0].trim()
  return req.headers.get('x-real-ip') ?? server.requestIP(req)?.address ?? 'unknown'
}
