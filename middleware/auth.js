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

export async function getAuthenticatedUser(req) {

    const authorization =
        req.headers.authorization;

    if (!authorization) {
        return null;
    }

    const [scheme, token] =
        authorization.split(" ");

    if (scheme !== "Bearer" || !token) {
        return null;
    }

    try {

        const { payload } = await jwtVerify(
            token,
            JWKS,
            {
                issuer,
                audience: AUTH0_AUDIENCE,
                algorithms: ["RS256"]
            }
        );

        return payload;

    } catch (error) {

        console.error(
            "Token validation failed:",
            error.message
        );

        return null;
    }
}