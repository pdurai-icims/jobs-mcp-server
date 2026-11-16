import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

export function createAuthenticator(config) {
    const client = jwksClient({
        jwksUri: new URL(".well-known/jwks.json", config.AUTH0_ISSUER).href,
        cache: true, rateLimit: true, jwksRequestsPerMinute: 10, timeout: 10_000
    });
    function getKey(header, callback) {
        client.getSigningKey(header.kid, (error, key) => {
            if (error) return callback(error);
            callback(null, key.getPublicKey());
        });
    }
    return async req => {
        const match = /^Bearer ([^ ]+)$/i.exec(req.headers.authorization ?? "");
        if (!match) return null;
        return new Promise(resolve => {
            jwt.verify(match[1], getKey, {
                audience: config.AUTH0_AUDIENCE,
                issuer: config.AUTH0_ISSUER,
                algorithms: ["RS256"]
            }, (error, decoded) => resolve(error || typeof decoded?.sub !== "string" ? null : decoded));
        });
    };
}
