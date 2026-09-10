import jwt from "jsonwebtoken";
import jwksClient from "jwks-rsa";

const client = jwksClient({
    jwksUri: "https://dev-duromcyrubs02o5n.us.auth0.com/.well-known/jwks.json"
});

function getKey(header, callback) {
    client.getSigningKey(header.kid, (err, key) => {
        if (err) return callback(err);
        callback(null, key.getPublicKey());
    });
}

export async function getAuthenticatedUser(req) {
    const authHeader = req.headers["authorization"];
    if (!authHeader?.startsWith("Bearer ")) return null;

    const token = authHeader.split(" ")[1];

    return new Promise((resolve, reject) => {
        jwt.verify(
            token,
            getKey,
            {
                audience: "https://jobs-mcp-server.onrender.com/mcp",
                issuer: "https://dev-duromcyrubs02o5n.us.auth0.com/",  // ← trailing slash required
                algorithms: ["RS256"]
            },
            (err, decoded) => {
                if (err) {
                    console.error("Token validation failed:", err.message);
                    resolve(null);  // ← resolve null, don't reject (avoids 500)
                } else {
                    resolve(decoded);
                }
            }
        );
    });
}