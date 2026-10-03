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

// emails are stored lowercase; the unique index is on lower(email)
export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email()),
  password: z.string().min(1),
});
export type LoginRequest = z.infer<typeof LoginRequest>;

export const RefreshRequest = z.object({
  refresh_token: z.string().min(1),
});
export type RefreshRequest = z.infer<typeof RefreshRequest>;

export type AuthTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};
