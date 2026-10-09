import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

// Public logos live in ./uploads (served by a strict path rule).
// Payment proofs live in ./private-uploads and are ONLY ever streamed through an authenticated endpoint.
export const PUBLIC_ROOT = path.resolve(process.cwd(), "uploads");
export const PRIVATE_ROOT = path.resolve(process.cwd(), "private-uploads");

export function sniffImage(buf) {
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpg";
  if (buf.length > 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP") return "webp";
  return null;
}

export async function savePrivate(tenantId, kind, buffer, ext) {
  const rel = `tenants/${tenantId}/${kind}/${crypto.randomBytes(12).toString("hex")}.${ext}`;
  const abs = path.join(PRIVATE_ROOT, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, buffer);
  return rel;
}
export const privateAbs = (rel) => path.join(PRIVATE_ROOT, rel);
export const removePrivate = (rel) => (rel ? fs.rm(privateAbs(rel), { force: true }) : Promise.resolve());
