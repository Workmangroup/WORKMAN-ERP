"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Building2, IdCard, KeyRound, Loader2, MapPin, Save, ShieldAlert, Users } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { ROLE_HOME, ROLE_LABELS } from "@/lib/constants";
import { formatDateTime, initials } from "@/lib/format";
import { Field, PageHeader } from "@/components/common/form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

function InfoRow({ icon: Icon, label, value }: { icon: typeof IdCard; label: string; value: string }) {
  return (
    <div className="flex items-center gap-3 rounded-lg bg-slate-50 px-4 py-3">
      <Icon className="size-4 text-wm-blue" />
      <div>
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className="text-sm font-medium text-slate-800">{value}</p>
      </div>
    </div>
  );
}

export default function ProfilPage() {
  const { user, refresh } = useAuth();
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [telephone, setTelephone] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const [pwd, setPwd] = useState({ ancien: "", nouveau: "", confirmation: "" });
  const [pwdErrors, setPwdErrors] = useState<Record<string, string>>({});
  const [pwdSaving, setPwdSaving] = useState(false);

  useEffect(() => {
    setEmail(user?.email ?? "");
    setTelephone(user?.telephone ?? "");
  }, [user]);

  if (!user) return null;

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErrors({});
    try {
      await api("/me/profile", { method: "PUT", body: { email, telephone } });
      await refresh();
      toast.success("Coordonnées mises à jour");
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors());
        toast.error(err.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!pwd.ancien) errs.ancien = "Obligatoire";
    if (pwd.nouveau.length < 10 || !/[a-z]/.test(pwd.nouveau) || !/[A-Z]/.test(pwd.nouveau) || !/\d/.test(pwd.nouveau))
      errs.nouveau = "10 caractères minimum, avec majuscule, minuscule et chiffre";
    if (pwd.nouveau !== pwd.confirmation) errs.confirmation = "Les mots de passe ne correspondent pas";
    setPwdErrors(errs);
    if (Object.keys(errs).length) return;

    setPwdSaving(true);
    try {
      await api("/auth/password", { method: "PUT", body: { ancien: pwd.ancien, nouveau: pwd.nouveau } });
      setPwd({ ancien: "", nouveau: "", confirmation: "" });
      const premiereConnexion = user?.mdp_temporaire;
      await refresh();
      toast.success(premiereConnexion ? "Mot de passe enregistré : bienvenue sur WORKVOICE !" : "Mot de passe modifié");
      if (premiereConnexion && user) router.replace(ROLE_HOME[user.role]);
    } catch (err) {
      if (err instanceof ApiError) {
        setPwdErrors(err.code === "BAD_PASSWORD" ? { ancien: err.message } : err.fieldErrors());
        toast.error(err.message);
      }
    } finally {
      setPwdSaving(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={user.mdp_temporaire ? "Bienvenue sur WORKVOICE" : "Mon profil"} />

      {user.mdp_temporaire && (
        <div className="mb-6 flex gap-3 rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-950">
          <ShieldAlert className="size-5 shrink-0 text-amber-700" />
          <div>
            <p className="font-semibold">Choisissez votre mot de passe personnel pour continuer.</p>
            <p className="mt-1">
              Votre compte a été créé (ou réinitialisé) par le service RH avec un mot de passe provisoire. Saisissez-le dans le
              premier champ, puis choisissez le vôtre. Il ne sera connu que de vous.
            </p>
          </div>
        </div>
      )}

      <div className="mb-6 flex flex-col items-start gap-5 rounded-xl border bg-card p-6 shadow-xs sm:flex-row sm:items-center">
        <div className="flex size-16 items-center justify-center rounded-2xl bg-wm-blue text-xl font-bold text-wm-yellow">
          {initials(user.prenom, user.nom)}
        </div>
        <div className="flex-1">
          <h2 className="text-xl font-bold">{user.prenom} {user.nom}</h2>
          <p className="text-sm text-muted-foreground">
            {ROLE_LABELS[user.role]} · Dernière connexion : {formatDateTime(user.derniere_connexion)}
          </p>
        </div>
      </div>

      <div className={user.mdp_temporaire ? "mx-auto max-w-lg" : "grid gap-6 lg:grid-cols-2"}>
        {!user.mdp_temporaire && (
        <section className="rounded-xl border bg-card p-6 shadow-xs">
          <h3 className="mb-1 font-semibold">Informations professionnelles</h3>
          <p className="mb-4 text-xs text-muted-foreground">Gérées par le service RH. Contactez-le pour toute correction.</p>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <InfoRow icon={IdCard} label="Matricule" value={user.matricule} />
            <InfoRow icon={Users} label="Service" value={user.service} />
            <InfoRow icon={Building2} label="Département" value={user.departement} />
            <InfoRow icon={MapPin} label="Site" value={user.site} />
          </div>

          <form onSubmit={saveProfile} className="mt-6 space-y-4 border-t pt-5" noValidate>
            <h3 className="font-semibold">Coordonnées</h3>
            <Field id="email" label="E-mail" error={errors.email} hint="Utilisé pour vous notifier des réponses RH.">
              <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="h-10" />
            </Field>
            <Field id="telephone" label="Téléphone" error={errors.telephone}>
              <Input id="telephone" type="tel" value={telephone} onChange={(e) => setTelephone(e.target.value)} className="h-10" />
            </Field>
            <Button type="submit" disabled={saving}>
              {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              Enregistrer
            </Button>
          </form>
        </section>
        )}

        <section className="rounded-xl border bg-card p-6 shadow-xs">
          <h3 className="mb-4 flex items-center gap-2 font-semibold">
            <KeyRound className="size-4 text-wm-blue" /> Changer mon mot de passe
          </h3>
          <form onSubmit={savePassword} className="space-y-4" noValidate>
            <Field id="ancien" label={user.mdp_temporaire ? "Mot de passe provisoire (communiqué par le RH)" : "Mot de passe actuel"} error={pwdErrors.ancien}>
              <Input id="ancien" type="password" autoComplete="current-password" value={pwd.ancien} onChange={(e) => setPwd({ ...pwd, ancien: e.target.value })} className="h-10" />
            </Field>
            <Field id="nouveau" label="Nouveau mot de passe" error={pwdErrors.nouveau} hint="10 caractères minimum, avec majuscule, minuscule et chiffre.">
              <Input id="nouveau" type="password" autoComplete="new-password" value={pwd.nouveau} onChange={(e) => setPwd({ ...pwd, nouveau: e.target.value })} className="h-10" />
            </Field>
            <Field id="confirmation" label="Confirmer" error={pwdErrors.confirmation}>
              <Input id="confirmation" type="password" autoComplete="new-password" value={pwd.confirmation} onChange={(e) => setPwd({ ...pwd, confirmation: e.target.value })} className="h-10" />
            </Field>
            <Button type="submit" disabled={pwdSaving}>
              {pwdSaving && <Loader2 className="size-4 animate-spin" />}
              Modifier le mot de passe
            </Button>
          </form>
        </section>
      </div>
    </div>
  );
}
