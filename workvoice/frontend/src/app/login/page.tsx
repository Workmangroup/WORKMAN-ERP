"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Eye, EyeOff, Loader2, Lock, MessageSquareHeart, ShieldCheck, Timer, UserRound } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { ApiError } from "@/lib/api";
import { ROLE_HOME } from "@/lib/constants";
import { Logo } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const FEATURES = [
  { icon: MessageSquareHeart, title: "Votre voix compte", text: "Demandes RH, réclamations et suggestions au même endroit." },
  { icon: ShieldCheck, title: "Confidentialité garantie", text: "Seul le service RH connaît votre identité. La Direction voit des données anonymisées." },
  { icon: Timer, title: "Suivi en temps réel", text: "Notifications à chaque réponse et changement de statut." },
];

function LoginForm() {
  const { user, loading, login } = useAuth();
  const router = useRouter();
  const params = useSearchParams();
  const [matricule, setMatricule] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const next = params.get("next");
  const target = (role: keyof typeof ROLE_HOME) =>
    next && next.startsWith(ROLE_HOME[role].slice(0, -1)) ? next : ROLE_HOME[role];

  useEffect(() => {
    if (!loading && user) router.replace(target(user.role));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, user]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!matricule.trim() || !password) {
      setError("Veuillez saisir votre matricule et votre mot de passe.");
      return;
    }
    setSubmitting(true);
    try {
      const u = await login(matricule.trim(), password);
      router.replace(target(u.role));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Connexion impossible");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-5" noValidate>
      <div className="space-y-1.5">
        <Label htmlFor="matricule">Matricule</Label>
        <div className="relative">
          <UserRound className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="matricule"
            autoComplete="username"
            autoFocus
            placeholder="Ex. WM1001"
            value={matricule}
            onChange={(e) => setMatricule(e.target.value.toUpperCase())}
            className="h-11 pl-9 text-base uppercase placeholder:normal-case"
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="password">Mot de passe</Label>
        <div className="relative">
          <Lock className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="password"
            type={showPassword ? "text" : "password"}
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-11 pr-10 pl-9 text-base"
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground"
            aria-label={showPassword ? "Masquer le mot de passe" : "Afficher le mot de passe"}
          >
            {showPassword ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}

      <Button type="submit" disabled={submitting} className="h-11 w-full text-base font-semibold">
        {submitting && <Loader2 className="size-4 animate-spin" />}
        Se connecter
      </Button>
      <p className="text-center text-xs text-muted-foreground">
        Mot de passe oublié ? Contactez le service RH de votre site.
      </p>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <section className="relative hidden overflow-hidden bg-wm-blue-dark p-12 text-white lg:flex lg:flex-col">
        <div className="absolute -top-32 -right-32 size-[28rem] rounded-full bg-wm-blue opacity-60 blur-3xl" />
        <div className="absolute -bottom-40 -left-20 size-[26rem] rounded-full bg-wm-yellow opacity-10 blur-3xl" />
        <div className="relative">
          <Logo inverted />
        </div>
        <div className="relative my-auto max-w-lg">
          <h1 className="text-4xl leading-tight font-bold">
            Exprimez-vous. <br />
            <span className="text-wm-yellow">Nous vous écoutons.</span>
          </h1>
          <p className="mt-4 text-lg text-blue-100/80">
            Le portail qui relie chaque collaborateur Workman au service Ressources Humaines.
          </p>
          <ul className="mt-10 space-y-6">
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <li key={title} className="flex gap-4">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/10 ring-1 ring-white/15">
                  <Icon className="size-5 text-wm-yellow" />
                </div>
                <div>
                  <p className="font-semibold">{title}</p>
                  <p className="text-sm text-blue-100/70">{text}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
        <p className="relative text-xs text-blue-200/50">© {new Date().getFullYear()} Workman · Usage interne</p>
      </section>

      <section className="flex items-center justify-center bg-white px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <Logo className="mb-10 lg:hidden" />
          <h2 className="text-2xl font-bold tracking-tight text-slate-900">Connexion</h2>
          <p className="mt-1 mb-8 text-sm text-muted-foreground">Identifiez-vous avec votre matricule Workman.</p>
          <Suspense>
            <LoginForm />
          </Suspense>
        </div>
      </section>
    </div>
  );
}
