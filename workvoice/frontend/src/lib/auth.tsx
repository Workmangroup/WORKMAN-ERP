"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api } from "./api";
import type { User } from "@/types";

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (matricule: string, password: string) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data } = await api<{ data: User }>("/auth/me");
      setUser(data);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const onUnauthorized = () => {
      setUser(null);
      router.replace("/login/");
    };
    window.addEventListener("wv:unauthorized", onUnauthorized);
    return () => window.removeEventListener("wv:unauthorized", onUnauthorized);
  }, [refresh, router]);

  const login = useCallback(async (matricule: string, password: string) => {
    const { data } = await api<{ data: User }>("/auth/login", { method: "POST", body: { matricule, password } });
    setUser(data);
    return data;
  }, []);

  const logout = useCallback(async () => {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    setUser(null);
    router.replace("/login/");
  }, [router]);

  return <AuthContext.Provider value={{ user, loading, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth doit être utilisé dans <AuthProvider>");
  return ctx;
}
