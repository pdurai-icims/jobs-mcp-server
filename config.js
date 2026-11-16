import { z } from "zod";

const publicUrl = z.string().url().transform(value => value.replace(/\/$/, "")).refine(value => {
    const url = new URL(value);
    return !url.username && !url.password && !url.search && !url.hash && url.pathname === "/" &&
        (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)));
}, "Use an HTTPS origin (HTTP is allowed only for localhost development).");

export function readConfig(env = process.env) {
    const parsed = z.object({
        PUBLIC_BASE_URL: publicUrl,
        AUTH0_ISSUER: publicUrl.refine(value => value.startsWith("https:"), "Auth0 requires HTTPS."),
        AUTH0_AUDIENCE: z.string().min(1),
        PORT: z.coerce.number().int().min(1).max(65535).default(3000),
        SESSION_TTL_MS: z.coerce.number().int().min(60_000).default(3_600_000),
        MAX_SESSIONS: z.coerce.number().int().min(1).default(250)
    }).safeParse(env);
    if (!parsed.success) {
        // Only field names: never include rejected secret values in startup errors.
        throw new Error(`Invalid or missing configuration: ${parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`);
    }
    const config = parsed.data;
    config.AUTH0_ISSUER = config.AUTH0_ISSUER.replace(/\/$/, "") + "/";
    return config;
}
