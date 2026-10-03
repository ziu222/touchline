import { SetMetadata } from '@nestjs/common';
import { userRoles, type UserRole } from '@touchline/shared';

export const PUBLIC_KEY = 'public';
export const ROLES_KEY = 'roles';

export const Public = () => SetMetadata(PUBLIC_KEY, true);
export const Roles = (...roles: UserRole[]) => SetMetadata(ROLES_KEY, roles);
export const AnyRole = () => Roles(...userRoles);

export type AuthUser = { id: string; role: UserRole; clubId: string };
export type AuthedRequest = { headers: Record<string, string | undefined>; ip?: string; user?: AuthUser };
