import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTH0_DOMAIN = process.env.AUTH0_DOMAIN;
const AUTH0_AUDIENCE = process.env.AUTH0_AUDIENCE;

if (!AUTH0_DOMAIN) {
    throw new Error("AUTH0_DOMAIN is not configured");
}

if (!AUTH0_AUDIENCE) {
    throw new Error("AUTH0_AUDIENCE is not configured");
}

const issuer = `https://${AUTH0_DOMAIN}/`;

const JWKS = createRemoteJWKSet(
    new URL(`${issuer}.well-known/jwks.json`)
);

export async function authenticate(req, res, next) {
    try {
        const authorization = req.headers.authorization;

        if (!authorization) {
            res.setHeader(
                "WWW-Authenticate",
                `Bearer resource_metadata="https://jobs-mcp-server.onrender.com/.well-known/oauth-protected-resource", scope="jobs:read jobs:create"`
            );

            return res.status(401).json({
                error: "Unauthorized"
            });
        }

        const [scheme, token] = authorization.split(" ");

        if (scheme !== "Bearer" || !token) {
            return res.status(401).json({
                error: "Invalid Authorization header"
            });
        }

        const { payload } = await jwtVerify(token, JWKS, {
            issuer,
            audience: AUTH0_AUDIENCE,
            algorithms: ["RS256"]
        });

        req.user = payload;

        next();

    } catch (error) {
        console.error(
            "Authentication failed:",
            error.message
        );

        return res.status(401).json({
            error: "Invalid or expired access token"
        });
    }
}