import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { webEnv } from "@/lib/env/web";

const redis = new Redis({
	url: webEnv.UPSTASH_REDIS_REST_URL,
	token: webEnv.UPSTASH_REDIS_REST_TOKEN,
});

export const baseRateLimit = new Ratelimit({
	redis,
	limiter: Ratelimit.slidingWindow(100, "1 m"), // 100 requests per minute
	analytics: true,
	prefix: "rate-limit",
});

// When the limiter store is unreachable, the Upstash client retries for several
// seconds before failing. Cap each check and trip a short circuit so a dead
// Redis (e.g. local dev without the proxy) doesn't add that latency to EVERY
// request — only the occasional probe after the cooldown.
const LIMITER_TIMEOUT_MS = 1500;
const LIMITER_COOLDOWN_MS = 60_000;
let skipLimiterUntil = 0;

export async function checkRateLimit({ request }: { request: Request }) {
	if (Date.now() < skipLimiterUntil) {
		return { success: true, limited: false };
	}

	const ip = request.headers.get("x-forwarded-for") ?? "anonymous";
	try {
		const limitPromise = baseRateLimit.limit(ip);
		// Avoid an unhandled rejection if the timeout wins the race below.
		limitPromise.catch(() => {});
		const result = await Promise.race([
			limitPromise,
			new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("rate-limit timeout")),
					LIMITER_TIMEOUT_MS,
				),
			),
		]);
		return { success: result.success, limited: !result.success };
	} catch (error) {
		// Rate limiting is best-effort: fail OPEN, and back off so we don't pay the
		// timeout on every request. We retry once the cooldown elapses in case the
		// limiter recovers.
		skipLimiterUntil = Date.now() + LIMITER_COOLDOWN_MS;
		console.warn("Rate limit check skipped (limiter unavailable):", error);
		return { success: true, limited: false };
	}
}
