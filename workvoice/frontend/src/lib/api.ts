const API_BASE = "/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
    public details?: { champ: string; message: string }[],
  ) {
    super(message);
  }

  /** Erreurs de validation indexées par champ, pour les formulaires. */
  fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.details ?? []).map((d) => [d.champ, d.message]));
  }
}

function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

async function csrfToken(force = false): Promise<string> {
  const existing = readCookie("wv_csrf");
  if (existing && !force) return existing;
  const res = await fetch(`${API_BASE}/auth/csrf`, { credentials: "include" });
  const data = await res.json();
  return data.csrfToken as string;
}

type Options = { method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE"; body?: unknown };

/**
 * Appel API : cookie de session envoyé automatiquement, jeton CSRF ajouté
 * sur les requêtes modifiantes (et renouvelé une fois s'il est refusé).
 */
export async function api<T = unknown>(path: string, { method = "GET", body }: Options = {}, retried = false): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  if (method !== "GET") headers["X-CSRF-Token"] = await csrfToken(retried);
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers,
      credentials: "include",
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "Impossible de joindre le serveur. Vérifiez votre connexion.");
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);

  if (!res.ok) {
    const err = data?.error ?? {};
    if (res.status === 403 && err.code === "CSRF_INVALID" && !retried) {
      return api<T>(path, { method, body }, true);
    }
    if (res.status === 401 && !path.startsWith("/auth/login")) {
      window.dispatchEvent(new Event("wv:unauthorized"));
    }
    // Mot de passe provisoire : le collaborateur doit d'abord choisir le sien
    if (res.status === 403 && err.code === "PASSWORD_CHANGE_REQUIRED" && !window.location.pathname.startsWith("/profil")) {
      window.location.href = "/profil/?changer=1";
    }
    throw new ApiError(res.status, err.message ?? "Une erreur est survenue", err.code, err.details);
  }
  return data as T;
}

export const apiUrl = (path: string) => `${API_BASE}${path}`;
