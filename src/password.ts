import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export const hashPassword = async (password: string): Promise<string> => {
  const salt = randomBytes(16).toString("hex");
  const derived = await scrypt(password, salt, 64) as Buffer;
  return `scrypt:${salt}:${derived.toString("hex")}`;
};

export const verifyPassword = async (password: string, hash: string): Promise<boolean> => {
  const [scheme, salt, stored] = hash.split(":");

  if (scheme !== "scrypt" || !salt || !stored) {
    return false;
  }

  const derived = await scrypt(password, salt, 64) as Buffer;
  const storedBuffer = Buffer.from(stored, "hex");

  return storedBuffer.length === derived.length && timingSafeEqual(storedBuffer, derived);
};
