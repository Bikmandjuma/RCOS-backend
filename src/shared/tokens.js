import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { env } from "../config/env.js";

export const signAccessToken = (user) =>
  jwt.sign({ sub: user.id, tv: user.tokenVersion }, env.jwtSecret, { expiresIn: env.jwtExpiresIn });

export const verifyAccessToken = (token) => jwt.verify(token, env.jwtSecret);

// Platform-operator tokens carry their own audience, so a restaurant token can never act as an admin (or the reverse).
export const signPlatformToken = (pu) => jwt.sign({ sub: pu.id, tv: pu.tokenVersion, aud: "platform" }, env.jwtSecret, { expiresIn: "8h" });
export const verifyPlatformToken = (token) => jwt.verify(token, env.jwtSecret, { audience: "platform" });

// Invitation tokens are random; only a SHA-256 hash is stored.
export const newOpaqueToken = () => crypto.randomBytes(32).toString("base64url");
export const hashToken = (t) => crypto.createHash("sha256").update(t).digest("hex");
