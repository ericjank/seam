import { randomUUID, createHash, randomBytes } from "node:crypto";

export const newId = () => randomUUID();
export const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");
export const newToken = () => randomBytes(32).toString("base64url");
