export type SupportedLang = 'uz' | 'ru' | 'en';
export type UserRole = 'user' | 'chamber' | 'admin';

export interface AuthUser {
  id: string;
  role: UserRole;
  lang?: SupportedLang;
}

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      lang: SupportedLang;
    }
  }
}

export {};
