import { z } from 'zod';

export const userRoles = [
  'sporting_director',
  'head_recruitment',
  'scout',
  'analyst',
  'doctor',
  'head_coach',
  'admin',
] as const;
export const UserRole = z.enum(userRoles);
export type UserRole = z.infer<typeof UserRole>;

export const LoginRequest = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;
