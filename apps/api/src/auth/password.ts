import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const argon2Async = promisify(argon2);

// OWASP argon2id baseline: 19 MiB, 2 passes, 1 lane
const PARAMS = { memory: 19456, passes: 2, parallelism: 1, tagLength: 32 };

// stored as argon2id$memory$passes$parallelism$salt$hash so params can change without breaking old hashes
export async function hashPassword(password: string): Promise<string> {
  const nonce = randomBytes(16);
  const tag = await argon2Async('argon2id', { message: password, nonce, ...PARAMS });
  return ['argon2id', PARAMS.memory, PARAMS.passes, PARAMS.parallelism, nonce.toString('base64'), tag.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, memory, passes, parallelism, salt, hash] = stored.split('$');
  if (alg !== 'argon2id' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const tag = await argon2Async('argon2id', {
    message: password,
    nonce: Buffer.from(salt, 'base64'),
    memory: Number(memory),
    passes: Number(passes),
    parallelism: Number(parallelism),
    tagLength: expected.length,
  });
  return timingSafeEqual(tag, expected);
}
