#!/usr/bin/env node
/**
 * Crée un utilisateur (par défaut : administrateur) sans passer par l'inscription publique.
 *
 *   node --env-file=.env.local scripts/create-admin.mjs <email> <mot_de_passe> "<Nom complet>" [role] [--force-change]
 *
 * Exemple :
 *   node --env-file=.env.local scripts/create-admin.mjs admin@mbconfection.com 'Chang3-Moi!Vite' "Admin MB"
 *
 * Nécessite NEXT_PUBLIC_SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from '@supabase/supabase-js'

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const forceChange = process.argv.includes('--force-change')
const [email, password, fullName = 'Administrateur', roleCode = 'admin'] = args

if (!email || !password) {
  console.error('Usage: node --env-file=.env.local scripts/create-admin.mjs <email> <mot_de_passe> "<Nom>" [role] [--force-change]')
  process.exit(1)
}
const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const key = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!url || !key) {
  console.error('NEXT_PUBLIC_SUPABASE_URL et SUPABASE_SERVICE_ROLE_KEY sont requis.')
  process.exit(1)
}

const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })

const { data: company, error: cErr } = await admin.from('companies').select('id').order('created_at').limit(1).single()
if (cErr) {
  console.error('Aucune société trouvée (migrations 0001/0002 appliquées ?) :', cErr.message)
  process.exit(1)
}
const { data: role, error: rErr } = await admin
  .from('roles').select('id').eq('company_id', company.id).eq('code', roleCode).single()
if (rErr) {
  console.error(`Rôle « ${roleCode} » introuvable :`, rErr.message)
  process.exit(1)
}

const { data: created, error: uErr } = await admin.auth.admin.createUser({
  email,
  password,
  email_confirm: true,
  user_metadata: { full_name: fullName },
  // app_metadata n'est modifiable que côté serveur : lu par le trigger handle_new_user()
  app_metadata: { company_id: company.id, user_type: 'internal', must_change_password: forceChange },
})
if (uErr) {
  console.error('Création impossible :', uErr.message)
  process.exit(1)
}

const { error: urErr } = await admin.from('user_roles').insert({ user_id: created.user.id, role_id: role.id })
if (urErr) {
  console.error('Utilisateur créé mais rôle non attribué :', urErr.message)
  process.exit(1)
}

console.log(`✔ ${email} créé (id ${created.user.id}) avec le rôle « ${roleCode} »${forceChange ? ' — changement de mot de passe exigé' : ''}.`)
