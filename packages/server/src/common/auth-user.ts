export interface AuthUser {
  id: string;
  role: string;
  phone?: string | null;
  kind: "user" | "admin";
}
