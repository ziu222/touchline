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
const Email = z.string().trim().toLowerCase().pipe(z.email());

export const LoginRequest = z.object({
  email: Email,
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

export const Pagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});
export type Pagination = z.infer<typeof Pagination>;

export type Page<T> = { data: T[]; meta: { page: number; limit: number; total: number } };

export const CreateUserRequest = z.object({
  email: Email,
  password: z.string().min(12).max(256),
  role: UserRole,
});
export type CreateUserRequest = z.infer<typeof CreateUserRequest>;

export const UpdateUserRequest = z
  .object({ role: UserRole.optional(), is_active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.is_active !== undefined, 'Nothing to update');
export type UpdateUserRequest = z.infer<typeof UpdateUserRequest>;

export type UserDto = {
  id: string;
  email: string;
  role: UserRole;
  is_active: boolean;
  locked_until: string | null;
  created_at: string;
};

export type ApiError = {
  error: { code: string; message: string; details?: unknown };
};
