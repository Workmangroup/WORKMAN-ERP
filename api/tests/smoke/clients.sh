#!/usr/bin/env bash
# Vérification de bout en bout de l'API clients (à lancer contre une API démarrée).
#   API_URL=http://localhost:8000 TOKEN_ADMIN=... TOKEN_NORIGHTS=... bash api/tests/smoke/clients.sh
# TOKEN_ADMIN : jeton Supabase d'un utilisateur avec clients.write et clients.delete.
# TOKEN_NORIGHTS : jeton d'un utilisateur sans droit clients.
# Le script crée des données de test portant le suffixe RUN, puis les supprime définitivement.
set -u
RUN=$(date +%s)
NAME="Smoke Test $RUN"
API_URL=${API_URL:-http://localhost:8000}
FAILED=0
check() { # $1 libellé, $2 attendu, $3 obtenu
  if [ "$2" = "$3" ]; then echo "PASS  $1"; else echo "FAIL  $1 (attendu $2, obtenu $3)"; FAILED=1; fi
}
code() { curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$@"; }
body() { curl -s --max-time 20 "$@"; }
# jget <chemin JS> : lit un champ du JSON reçu sur l'entrée standard (ex. data.id)
jget() { node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);const v=eval('j.'+process.argv[1]);console.log(v===undefined||v===null?'':v)}catch(e){console.log('')}})" "$1"; }
ADMIN=(-H "Authorization: Bearer $TOKEN_ADMIN" -H 'Content-Type: application/json')
NORIGHTS=(-H "Authorization: Bearer $TOKEN_NORIGHTS" -H 'Content-Type: application/json')

# ---- Socle : santé, jeton, création, liste ----
check "santé : 200" 200 "$(code "$API_URL/api/v1/health")"
check "liste sans jeton : 401" 401 "$(code "$API_URL/api/v1/clients")"
check "liste admin : 200" 200 "$(code -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients")"
check "création sans droit : 403" 403 "$(code -X POST "${NORIGHTS[@]}" -d '{"name":"Intrus","country":"FR","currency":"EUR","language":"fr"}' "$API_URL/api/v1/clients")"
check "pays invalide : 422" 422 "$(code -X POST "${ADMIN[@]}" -d '{"name":"Test","country":"XX","currency":"EUR","language":"fr"}' "$API_URL/api/v1/clients")"

CREATED=$(body -X POST "${ADMIN[@]}" -d "{\"name\":\"$NAME\",\"country\":\"FR\",\"currency\":\"EUR\",\"language\":\"fr\",\"vat_exempt\":false}" "$API_URL/api/v1/clients")
ID=$(printf '%s' "$CREATED" | jget data.id)
check "création admin : identifiant renvoyé" 1 "$([ -n "$ID" ] && echo 1 || echo 0)"

LIST=$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients?q=Smoke%20Test%20$RUN")
check "recherche par nom : le client créé est trouvé" 1 "$(printf '%s' "$LIST" | grep -c "$RUN")"
check "statut archivé : aucun client archivé dans ce jeu" 0 "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients?status=archived&q=Smoke%20Test%20$RUN" | jget meta.total)"

check "modification admin : 200" 200 "$(code -X PATCH "${ADMIN[@]}" -d '{"phone":"+216 70 000 000"}' "$API_URL/api/v1/clients/$ID")"
check "modification sans droit : 404 (pas de fuite d'information)" 404 "$(code -X PATCH "${NORIGHTS[@]}" -d '{"phone":"hack"}' "$API_URL/api/v1/clients/$ID")"
check "identifiant inconnu : 404" 404 "$(code -X PATCH "${ADMIN[@]}" -d '{"phone":"x"}' "$API_URL/api/v1/clients/00000000-0000-0000-0000-000000000000")"

# ---- Fiche ----
check "fiche admin : 200" 200 "$(code -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients/$ID")"
check "fiche sans droit : 404" 404 "$(code -H "Authorization: Bearer $TOKEN_NORIGHTS" "$API_URL/api/v1/clients/$ID")"
check "fiche : le nom renvoyé est celui créé" "$NAME" "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients/$ID" | jget data.name)"

# ---- Contacts ----
CONTACT=$(body -X POST "${ADMIN[@]}" -d '{"full_name":"Contact Smoke","email":"smoke@example.com","is_primary":true}' "$API_URL/api/v1/clients/$ID/contacts")
CID=$(printf '%s' "$CONTACT" | jget data.id)
check "contact : création admin 201" 201 "$(code -X POST "${ADMIN[@]}" -d '{"full_name":"Contact Smoke 2"}' "$API_URL/api/v1/clients/$ID/contacts")"
check "contact : nom manquant 422" 422 "$(code -X POST "${ADMIN[@]}" -d '{"email":"a@b.co"}' "$API_URL/api/v1/clients/$ID/contacts")"
check "contact : création sans droit 403" 403 "$(code -X POST "${NORIGHTS[@]}" -d '{"full_name":"Intrus"}' "$API_URL/api/v1/clients/$ID/contacts")"
check "contact : liste contient le contact principal" 1 "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients/$ID/contacts" | grep -c "Contact Smoke")"
check "contact : modification 200" 200 "$(code -X PATCH "${ADMIN[@]}" -d '{"job_title":"Acheteur"}' "$API_URL/api/v1/contacts/$CID")"
check "contact : suppression sans droit : 404 (pas de fuite d'information)" 404 "$(code -X DELETE -H "Authorization: Bearer $TOKEN_NORIGHTS" "$API_URL/api/v1/contacts/$CID")"
check "contact : suppression admin 200" 200 "$(code -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/contacts/$CID")"
check "contact : suppression d'un contact disparu 404" 404 "$(code -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/contacts/$CID")"

# ---- Adresses ----
ADDR=$(body -X POST "${ADMIN[@]}" -d '{"type":"delivery","line1":"12 rue du Test","city":"Tunis","country":"TN"}' "$API_URL/api/v1/clients/$ID/addresses")
AID=$(printf '%s' "$ADDR" | jget data.id)
check "adresse : création admin 201" 201 "$(code -X POST "${ADMIN[@]}" -d '{"type":"other","line1":"Adresse 2","city":"Sfax","country":"TN"}' "$API_URL/api/v1/clients/$ID/addresses")"
check "adresse : type inconnu 422" 422 "$(code -X POST "${ADMIN[@]}" -d '{"type":"inconnu","line1":"Rue","city":"Tunis","country":"TN"}' "$API_URL/api/v1/clients/$ID/addresses")"
check "adresse : modification 200" 200 "$(code -X PATCH "${ADMIN[@]}" -d '{"city":"Ariana"}' "$API_URL/api/v1/addresses/$AID")"
check "adresse : suppression sans droit : 404 (pas de fuite d'information)" 404 "$(code -X DELETE -H "Authorization: Bearer $TOKEN_NORIGHTS" "$API_URL/api/v1/addresses/$AID")"
check "adresse : suppression admin 200" 200 "$(code -X DELETE -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/addresses/$AID")"

# ---- Archivage / restauration (clients.delete) ----
check "archivage sans droit 403" 403 "$(code -X POST "${NORIGHTS[@]}" -d '{"reason":"test"}' "$API_URL/api/v1/clients/$ID/archive")"
check "archivage admin 200" 200 "$(code -X POST "${ADMIN[@]}" -d '{"reason":"Smoke"}' "$API_URL/api/v1/clients/$ID/archive")"
check "archivé : apparaît dans la liste archivée" 1 "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients?status=archived&q=Smoke%20Test%20$RUN" | grep -c "$RUN")"
check "restauration admin 200" 200 "$(code -X POST "${ADMIN[@]}" "$API_URL/api/v1/clients/$ID/restore")"
check "restauré : ne figure plus parmi les archivés" 0 "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients?status=archived&q=Smoke%20Test%20$RUN" | jget meta.total)"

# ---- Annuaires ----
check "conditions de paiement : 200" 200 "$(code -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/payment-terms")"
check "commerciaux : 200" 200 "$(code -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/sales-reps")"
check "annuaire utilisateurs sans identifiant : liste vide" 0 "$(body -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/users/directory" | jget data.length)"

# ---- Suppression définitive (clients.delete) ----
check "suppression sans confirmation : 422" 422 "$(code -X DELETE "${ADMIN[@]}" -d '{}' "$API_URL/api/v1/clients/$ID")"
check "suppression d'un client actif : refusée (CLIENT_NOT_ARCHIVED)" CLIENT_NOT_ARCHIVED "$(body -X DELETE "${ADMIN[@]}" -d '{"confirm":"SUPPRIMER"}' "$API_URL/api/v1/clients/$ID" | jget error)"
check "suppression sans droit : 403" 403 "$(code -X DELETE "${NORIGHTS[@]}" -d '{"confirm":"SUPPRIMER"}' "$API_URL/api/v1/clients/$ID")"
check "archivage préalable admin 200" 200 "$(code -X POST "${ADMIN[@]}" -d '{"reason":"Smoke suppression"}' "$API_URL/api/v1/clients/$ID/archive")"
check "suppression admin 200" 200 "$(code -X DELETE "${ADMIN[@]}" -d '{"confirm":"SUPPRIMER"}' "$API_URL/api/v1/clients/$ID")"
check "client supprimé : fiche 404" 404 "$(code -H "Authorization: Bearer $TOKEN_ADMIN" "$API_URL/api/v1/clients/$ID")"

exit $FAILED
