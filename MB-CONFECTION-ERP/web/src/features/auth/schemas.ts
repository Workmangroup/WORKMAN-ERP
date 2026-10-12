import { z } from 'zod'

export const emailSchema = z
  .string({ error: 'Adresse e-mail requise' })
  .trim()
  .toLowerCase()
  .pipe(z.email({ error: 'Adresse e-mail invalide' }))

/** Politique : 10+ caractères, minuscule, majuscule, chiffre et symbole (72 max : limite bcrypt). */
export const passwordSchema = z
  .string({ error: 'Mot de passe requis' })
  .min(10, 'Au moins 10 caractères')
  .max(72, '72 caractères maximum')
  .regex(/[a-z]/, 'Au moins une minuscule')
  .regex(/[A-Z]/, 'Au moins une majuscule')
  .regex(/\d/, 'Au moins un chiffre')
  .regex(/[^A-Za-z0-9]/, 'Au moins un symbole')

export const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1, 'Mot de passe requis').max(200),
  next: z.string().optional(),
})

export const forgotPasswordSchema = z.object({ email: emailSchema })

export const resetPasswordSchema = z
  .object({ password: passwordSchema, confirm: z.string() })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], error: 'Les mots de passe ne correspondent pas' })

export const changePasswordSchema = z
  .object({
    current: z.string().min(1, 'Mot de passe actuel requis'),
    password: passwordSchema,
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ['confirm'], error: 'Les mots de passe ne correspondent pas' })
  .refine((v) => v.password !== v.current, { path: ['password'], error: 'Le nouveau mot de passe doit être différent' })

/** Évalue la robustesse (0-4) pour l'indicateur visuel. */
export function passwordScore(pw: string) {
  const checks = [pw.length >= 10, /[a-z]/.test(pw), /[A-Z]/.test(pw), /\d/.test(pw), /[^A-Za-z0-9]/.test(pw)]
  const passed = checks.filter(Boolean).length
  const bonus = pw.length >= 14 ? 1 : 0
  return { checks, score: Math.min(4, Math.max(0, passed - 1 + bonus)) as 0 | 1 | 2 | 3 | 4 }
}
