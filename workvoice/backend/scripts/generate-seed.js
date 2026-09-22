/**
 * Génère database/03_seed.sql : jeu de données de démonstration réaliste
 * (janvier → septembre 2026). Déterministe grâce à un PRNG à graine fixe.
 *
 *   npm run seed:generate
 *
 * Mot de passe de tous les comptes de démo : Workman@2026
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(__dirname, '../../database/03_seed.sql');

const DEMO_PASSWORD = 'Workman@2026';
const TODAY = new Date('2026-09-22T09:00:00');
const START = new Date('2026-01-05T08:00:00');

// ---------------------------------------------------------------- PRNG
let seed = 20260922;
function rand() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const between = (min, max) => min + rand() * (max - min);
function weighted(entries) {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) { if ((r -= w) < 0) return v; }
  return entries[entries.length - 1][0];
}

// ---------------------------------------------------------------- Helpers SQL
const q = (v) => (v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`);
const pad = (n) => String(n).padStart(2, '0');
const dt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
const addHours = (d, h) => new Date(d.getTime() + h * 3600 * 1000);
function workHours(d) {
  const x = new Date(d);
  if (x.getDay() === 0) x.setDate(x.getDate() + 1); // pas de dimanche
  x.setHours(8 + Math.floor(rand() * 9), Math.floor(rand() * 60), Math.floor(rand() * 60));
  return x;
}
const randomDate = () => workHours(new Date(START.getTime() + rand() * (TODAY.getTime() - START.getTime() - 86400000)));
const cap = (d) => (d > TODAY ? addHours(TODAY, -1 - rand() * 5) : d);
function insert(table, cols, rows) {
  if (!rows.length) return '';
  const lines = rows.map((r) => `  (${cols.map((c) => q(r[c])).join(', ')})`);
  return `INSERT INTO ${table} (${cols.join(', ')}) VALUES\n${lines.join(',\n')};\n\n`;
}

// ---------------------------------------------------------------- Organisation
const ORGA = [
  // [département, service, sites, poids]
  ['Production', 'Coupe', ['Sousse', 'Monastir'], 5],
  ['Production', 'Confection', ['Sousse', 'Monastir'], 7],
  ['Production', 'Finition', ['Sousse'], 3],
  ['Production', 'Broderie & Marquage', ['Monastir'], 2],
  ['Supply Chain', 'Logistique', ['Sousse', 'Sfax'], 3],
  ['Supply Chain', 'Achats', ['Tunis'], 1],
  ['Supply Chain', 'Magasin', ['Sousse', 'Sfax'], 2],
  ['Commercial', 'Ventes', ['Tunis', 'Sfax'], 2],
  ['Commercial', 'Service Client', ['Tunis'], 1],
  ['Technique', 'Maintenance', ['Sousse', 'Monastir'], 2],
  ['Technique', 'Qualité', ['Sousse'], 2],
  ['Technique', 'Informatique', ['Tunis'], 1],
  ['Administration', 'Finance & Comptabilité', ['Tunis'], 1],
];

const PRENOMS_H = ['Mohamed', 'Ahmed', 'Youssef', 'Aymen', 'Walid', 'Bilel', 'Anis', 'Hamza', 'Skander', 'Nabil', 'Fares', 'Oussama', 'Rami', 'Slim', 'Mehrez'];
const PRENOMS_F = ['Amira', 'Nour', 'Ines', 'Rania', 'Mariem', 'Sonia', 'Hela', 'Yosra', 'Olfa', 'Asma', 'Emna', 'Salma', 'Wafa', 'Ghada', 'Syrine'];
const NOMS = ['Ben Salah', 'Jaziri', 'Hammami', 'Bouazizi', 'Chaouch', 'Mejri', 'Ayari', 'Karray', 'Zouari', 'Dridi', 'Jlassi', 'Khelifi', 'Sassi', 'Belhadj', 'Mabrouk', 'Ferchichi', 'Souissi', 'Baccar', 'Guesmi', 'Laabidi', 'Masmoudi', 'Rekik', 'Ouertani', 'Chebbi', 'Tlili'];

const slug = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]+/g, '.').replace(/^\.|\.$/g, '');

const hash = bcrypt.hashSync(DEMO_PASSWORD, 10);
const users = [];
const usedNames = new Set();

function addUser(u) {
  const id = users.length + 1;
  const email = `${slug(u.prenom)}.${slug(u.nom)}@workman.tn`;
  const created = workHours(new Date(2025, Math.floor(rand() * 12), 1 + Math.floor(rand() * 27)));
  users.push({
    id, email, password: hash, actif: 1, created_at: dt(created),
    telephone: `+216 ${pick(['2', '5', '9'])}${Math.floor(rand() * 10)} ${String(Math.floor(rand() * 1000)).padStart(3, '0')} ${String(Math.floor(rand() * 1000)).padStart(3, '0')}`,
    ...u,
  });
  usedNames.add(`${u.prenom} ${u.nom}`);
  return id;
}

addUser({ matricule: 'RH001', prenom: 'Sana', nom: 'Ben Ammar', service: 'Ressources Humaines', departement: 'Administration', site: 'Tunis', role: 'RH' });
addUser({ matricule: 'RH002', prenom: 'Karim', nom: 'Trabelsi', service: 'Ressources Humaines', departement: 'Administration', site: 'Sousse', role: 'RH' });
addUser({ matricule: 'DG001', prenom: 'Hichem', nom: 'Gharbi', service: 'Direction Générale', departement: 'Direction', site: 'Tunis', role: 'DIRECTION' });
addUser({ matricule: 'DG002', prenom: 'Leila', nom: 'Mansour', service: 'Direction Industrielle', departement: 'Direction', site: 'Sousse', role: 'DIRECTION' });

// Compte employé de démo stable (documenté dans le README)
addUser({ matricule: 'WM1001', prenom: 'Amira', nom: 'Hammami', service: 'Confection', departement: 'Production', site: 'Sousse', role: 'EMPLOYE' });

const orgaWeights = ORGA.map((o) => [o, o[3]]);
for (let i = 2; i <= 32; i++) {
  let prenom, nom;
  do {
    prenom = rand() < 0.5 ? pick(PRENOMS_H) : pick(PRENOMS_F);
    nom = pick(NOMS);
  } while (usedNames.has(`${prenom} ${nom}`));
  const [departement, service, sites] = weighted(orgaWeights);
  addUser({ matricule: `WM${1000 + i}`, prenom, nom, service, departement, site: pick(sites), role: 'EMPLOYE' });
}
// Un compte désactivé (ancien collaborateur) pour tester le contrôle d'accès
users[users.length - 1].actif = 0;

const employees = users.filter((u) => u.role === 'EMPLOYE' && u.actif);
const rhUsers = users.filter((u) => u.role === 'RH');
const dirUsers = users.filter((u) => u.role === 'DIRECTION');

// ---------------------------------------------------------------- Contenus
const DEMANDES = {
  ATTESTATION_TRAVAIL: [
    ['Attestation de travail — dossier bancaire', "Bonjour, je souhaite obtenir une attestation de travail pour compléter mon dossier de prêt immobilier auprès de ma banque. Merci d'avance."],
    ['Attestation de travail pour visa', "Je dois déposer une demande de visa Schengen le mois prochain et l'ambassade exige une attestation de travail récente."],
    ['Attestation de travail — location', "Mon futur propriétaire me demande une attestation de travail pour la signature du bail."],
  ],
  ATTESTATION_SALAIRE: [
    ['Attestation de salaire — crédit auto', "Merci de me fournir une attestation de salaire des trois derniers mois pour une demande de crédit automobile."],
    ['Attestation de salaire annuelle', "J'ai besoin d'une attestation de salaire annuelle pour ma déclaration fiscale."],
  ],
  SOLDE_CONGES: [
    ['Consultation solde de congés', "Pouvez-vous m'indiquer mon solde de congés payés restant à ce jour, ainsi que les jours à poser avant la fin de l'année ?"],
    ['Écart sur mon solde de congés', "Mon bulletin indique 12 jours de solde alors que je pense en avoir 15. Pouvez-vous vérifier ?"],
  ],
  CONGE: [
    ['Congé annuel — été', "Je souhaite poser deux semaines de congé annuel du 3 au 14 août. Mon responsable a donné son accord verbal."],
    ['Congé pour mariage', "Je me marie le mois prochain et souhaite bénéficier du congé exceptionnel pour mariage prévu par la convention."],
    ['Congé sans solde', "Je sollicite un congé sans solde d'une semaine pour raisons familiales."],
  ],
  AVANCE_SALAIRE: [
    ['Avance sur salaire — frais médicaux', "Suite à des frais médicaux imprévus, je sollicite une avance sur salaire de 500 DT remboursable sur deux mois."],
    ['Avance sur salaire — rentrée scolaire', "Je souhaite bénéficier d'une avance sur salaire pour couvrir les frais de rentrée scolaire de mes enfants."],
  ],
  FORMATION: [
    ['Formation Excel avancé', "Je souhaite suivre une formation Excel avancé pour améliorer le suivi des indicateurs de production de mon équipe."],
    ['Formation habilitation électrique', "Mon habilitation électrique arrive à échéance. Merci de m'inscrire à la prochaine session de recyclage."],
    ['Formation management d\'équipe', "Récemment nommé chef d'équipe, je souhaite suivre une formation en management de proximité."],
  ],
  AUTRE: [
    ['Mise à jour de ma situation familiale', "Je souhaite mettre à jour ma situation familiale (naissance) pour les allocations et la mutuelle."],
    ['Changement de RIB', "Je vous informe de mon changement de banque. Vous trouverez mon nouveau RIB en pièce jointe."],
  ],
};

const RECLAMATIONS = {
  PAIE: [
    ['Heures supplémentaires non payées', "Les heures supplémentaires effectuées pendant l'inventaire du mois dernier n'apparaissent pas sur mon bulletin de paie."],
    ['Erreur sur la prime de rendement', "La prime de rendement versée ce mois-ci ne correspond pas à l'objectif atteint par notre ligne de production."],
    ['Retard de versement du salaire', "Le salaire de ce mois a été versé avec quatre jours de retard, ce qui m'a causé des frais bancaires."],
  ],
  CONDITIONS_TRAVAIL: [
    ['Chaleur excessive dans l\'atelier', "La température dans l'atelier dépasse régulièrement 35 °C l'après-midi. Les ventilateurs sont insuffisants et plusieurs collègues ont eu des malaises."],
    ['Éclairage insuffisant au poste de travail', "L'éclairage de la ligne 3 est trop faible pour les travaux de couture fine, ce qui provoque de la fatigue visuelle."],
    ['Vestiaires en mauvais état', "Les vestiaires femmes n'ont plus de casiers fonctionnels et les douches sont hors service depuis plusieurs semaines."],
    ['Bruit permanent zone de coupe', "Le niveau sonore dans la zone de coupe est très élevé et les protections auditives ne sont plus distribuées."],
  ],
  RESPONSABLE_HIERARCHIQUE: [
    ['Communication difficile avec le chef d\'équipe', "Les consignes changent plusieurs fois par jour sans explication, et les remarques sont faites devant toute l'équipe de manière humiliante."],
    ['Refus répété de congés', "Mes demandes de congé sont systématiquement refusées sans justification alors que d'autres collègues obtiennent les leurs."],
    ['Répartition inéquitable des tâches', "Les tâches les plus pénibles sont toujours attribuées aux mêmes personnes de l'équipe."],
  ],
  EQUIPEMENT: [
    ['Machine à coudre défectueuse', "Ma machine piqueuse tombe en panne plusieurs fois par jour. La maintenance intervient mais le problème revient systématiquement."],
    ['Chaises ergonomiques manquantes', "Les postes de finition ne disposent pas de chaises réglables, ce qui cause des douleurs dorsales."],
    ['Ordinateur trop lent', "Mon poste informatique met plus de dix minutes à démarrer et bloque l'utilisation de l'ERP."],
    ['EPI en rupture', "Il n'y a plus de gants anti-coupure à ma taille depuis trois semaines."],
  ],
  SECURITE: [
    ['Non-respect des consignes de sécurité', "Le responsable ne respecte pas les consignes de sécurité et demande de retirer les carters de protection pour aller plus vite."],
    ['Issue de secours encombrée', "L'issue de secours côté magasin est bloquée par des palettes depuis plusieurs jours."],
    ['Extincteurs non vérifiés', "Les extincteurs de l'atelier n'ont pas d'étiquette de vérification à jour."],
    ['Chariot élévateur sans formation', "Des collègues non formés conduisent le chariot élévateur dans l'entrepôt."],
  ],
  HARCELEMENT: [
    ['Propos déplacés répétés', "Je subis depuis plusieurs semaines des remarques déplacées et répétées d'un collègue. J'ai peur des représailles si j'en parle ouvertement."],
    ['Pression et intimidation', "Je fais l'objet de pressions et d'intimidations constantes, avec des menaces sur mon contrat. Je souhaite être reçu(e) en toute confidentialité."],
  ],
  ORGANISATION: [
    ['Plannings communiqués trop tard', "Les plannings de la semaine sont communiqués le dimanche soir, ce qui rend impossible l'organisation familiale."],
    ['Transport du personnel', "Le bus du personnel de l'équipe de nuit arrive régulièrement en retard, ce qui nous fait pointer en retard."],
    ['Pause déjeuner écourtée', "La pause déjeuner est régulièrement réduite à 20 minutes en fin de mois pour tenir les délais."],
  ],
  AUTRE: [
    ['Cantine — qualité des repas', "La qualité des repas servis à la cantine s'est nettement dégradée ces derniers mois."],
    ['Parking insuffisant', "Le parking du personnel est saturé dès 7 h 30 et nous devons nous garer dans la rue."],
  ],
};

const SUGGESTIONS = [
  ['ORGANISATION', 'Tableau de polyvalence', "Mettre en place un tableau de polyvalence affiché dans chaque atelier pour faciliter les remplacements."],
  ['QUALITE', 'Contrôle qualité en bout de ligne', "Ajouter un point de contrôle rapide en bout de ligne de confection pour réduire les retours clients."],
  ['SECURITE', 'Quart d\'heure sécurité mensuel', "Organiser chaque mois un quart d'heure sécurité avec partage des presque-accidents."],
  ['BIEN_ETRE', 'Espace de pause ombragé', "Aménager un espace de pause extérieur ombragé avec des bancs pour l'été."],
  ['ENVIRONNEMENT', 'Recyclage des chutes de tissu', "Valoriser les chutes de tissu en partenariat avec une association locale plutôt que de les jeter."],
  ['DIGITAL', 'Bulletins de paie dématérialisés', "Proposer les bulletins de paie en version numérique sur WORKVOICE."],
  ['DIGITAL', 'Application de pointage mobile', "Permettre aux commerciaux terrain de pointer via une application mobile."],
  ['BIEN_ETRE', 'Fontaines à eau fraîche', "Installer des fontaines à eau fraîche supplémentaires dans les ateliers de production."],
  ['ORGANISATION', 'Réunion d\'équipe hebdomadaire', "Instaurer un point d'équipe de 10 minutes chaque lundi pour partager les priorités de la semaine."],
  ['QUALITE', 'Fiches de poste illustrées', "Remplacer les fiches de poste textuelles par des fiches illustrées avec photos des opérations."],
  ['AUTRE', 'Journée familles', "Organiser une journée portes ouvertes pour les familles des collaborateurs."],
  ['ENVIRONNEMENT', 'Réduction de l\'éclairage inutile', "Installer des détecteurs de présence dans les couloirs et les stocks."],
];

const RH_REPONSES = {
  prise: [
    'Bonjour, nous avons bien reçu votre demande et la prenons en charge. Nous revenons vers vous rapidement.',
    'Merci pour votre message. Votre dossier est en cours de traitement par le service RH.',
    'Bonjour, votre demande est en cours d\'analyse. Nous vous tiendrons informé(e) de son avancement.',
  ],
  attente: [
    'Pourriez-vous nous transmettre un justificatif complémentaire afin que nous puissions finaliser le traitement ?',
    'Nous attendons le retour de votre responsable hiérarchique pour poursuivre le traitement.',
    'Merci de préciser les dates exactes concernées afin que nous puissions vérifier.',
  ],
  reponseEmploye: [
    'Merci, je vous transmets le document demandé.',
    'Bonjour, voici les précisions demandées. Merci pour votre suivi.',
    "D'accord, j'attends votre retour.",
  ],
  resolu: {
    demande: [
      'Votre document est prêt. Vous pouvez le récupérer au bureau RH ou le recevoir par e-mail.',
      'Votre demande a été validée. Les informations ont été mises à jour dans votre dossier.',
      'Demande traitée : la régularisation apparaîtra sur votre prochain bulletin de paie.',
    ],
    reclamation: [
      'Suite à votre réclamation, une action corrective a été mise en place avec le responsable concerné.',
      'Le problème signalé a été transmis au service concerné et corrigé. Merci pour votre vigilance.',
      'Un entretien a été organisé et des mesures ont été prises. N\'hésitez pas à nous recontacter si la situation se reproduit.',
    ],
    suggestion: [
      'Merci pour cette excellente idée ! Elle a été présentée en comité de direction et sera mise en œuvre prochainement.',
      'Votre suggestion a été étudiée avec attention. Elle sera intégrée au plan d\'amélioration du prochain trimestre.',
    ],
  },
};

// ---------------------------------------------------------------- Génération des tickets
const comments = [];
const notifications = [];

function statusFor(created, kind) {
  const ageDays = (TODAY - created) / 86400000;
  if (ageDays > 45) return weighted([['CLOTURE', 70], ['RESOLU', 22], ['EN_ATTENTE', 4], ['EN_COURS', 4]]);
  if (ageDays > 15) return weighted([['CLOTURE', 35], ['RESOLU', 30], ['EN_COURS', 20], ['EN_ATTENTE', 15]]);
  if (ageDays > 4) return weighted([['RESOLU', 15], ['EN_COURS', 45], ['EN_ATTENTE', 20], ['NOUVEAU', 20]]);
  return kind === 'demande' ? weighted([['NOUVEAU', 60], ['EN_COURS', 40]]) : weighted([['NOUVEAU', 70], ['EN_COURS', 30]]);
}

const kindCfg = {
  demande: { fk: 'demande_id', kind: 'demande', path: 'demandes', label: 'demande RH', delai: [4, 120] },
  reclamation: { fk: 'reclamation_id', kind: 'reclamation', path: 'reclamations', label: 'réclamation', delai: [24, 480] },
  suggestion: { fk: 'suggestion_id', kind: 'suggestion', path: 'suggestions', label: 'suggestion', delai: [48, 600] },
};

function buildThread(kind, ticket, owner) {
  const cfg = kindCfg[kind];
  const created = new Date(ticket.date_creation);
  const rh = pick(rhUsers);
  let t = created;
  const push = (userId, message, hoursLater) => {
    t = cap(addHours(t, hoursLater));
    comments.push({ [cfg.fk]: ticket.id, user_id: userId, message, date_creation: dt(t) });
    return t;
  };

  if (ticket.statut === 'NOUVEAU') return null;

  const firstReply = push(rh.id, pick(RH_REPONSES.prise), between(1, 30));
  notifications.push({
    user_id: owner.id, type: 'REPONSE_RH', titre: `Nouvelle réponse sur ${ticket.numero}`,
    message: `Le service RH a répondu à votre ${cfg.label} « ${ticket.objet} ».`,
    lien: `/employe/ticket/?kind=${cfg.kind}&id=${ticket.id}`, lu: rand() < 0.7 ? 1 : 0, date_creation: dt(firstReply),
  });

  if (ticket.statut === 'EN_ATTENTE' || rand() < 0.35) {
    push(rh.id, pick(RH_REPONSES.attente), between(4, 48));
    if (ticket.statut !== 'EN_ATTENTE') push(owner.id, pick(RH_REPONSES.reponseEmploye), between(2, 36));
  }

  if (ticket.statut === 'RESOLU' || ticket.statut === 'CLOTURE') {
    const closeAt = cap(addHours(created, between(...cfg.delai)));
    const finalAt = closeAt > t ? closeAt : cap(addHours(t, 1));
    comments.push({ [cfg.fk]: ticket.id, user_id: rh.id, message: pick(RH_REPONSES.resolu[kind]), date_creation: dt(finalAt) });
    notifications.push({
      user_id: owner.id, type: 'STATUT_MAJ', titre: `${ticket.numero} : ${ticket.statut === 'CLOTURE' ? 'Clôturé' : 'Résolu'}`,
      message: `Votre ${cfg.label} « ${ticket.objet} » a été traitée.`,
      lien: `/employe/ticket/?kind=${cfg.kind}&id=${ticket.id}`, lu: rand() < 0.85 ? 1 : 0, date_creation: dt(finalAt),
    });
    return finalAt;
  }
  return null;
}

function numbered(prefix, rows) {
  rows.sort((a, b) => a._date - b._date);
  rows.forEach((r, i) => {
    r.id = i + 1;
    r._numero = `${prefix}-2026-${String(i + 1).padStart(4, '0')}`;
  });
  return rows;
}

// Demandes
const demandeTypeWeights = [['ATTESTATION_TRAVAIL', 20], ['ATTESTATION_SALAIRE', 14], ['SOLDE_CONGES', 12], ['CONGE', 22], ['AVANCE_SALAIRE', 10], ['FORMATION', 12], ['AUTRE', 8]];
const demandes = numbered('DEM', Array.from({ length: 72 }, () => {
  const type = weighted(demandeTypeWeights);
  const [objet, description] = pick(DEMANDES[type]);
  return { _date: randomDate(), type, objet, description };
}));

const demandeRows = demandes.map((d) => {
  const owner = pick(employees);
  const statut = statusFor(d._date, 'demande');
  const row = {
    id: d.id, numero_demande: d._numero, numero: d._numero, user_id: owner.id, type_demande: d.type, objet: d.objet,
    description: d.description, piece_jointe: null, piece_jointe_nom: null, piece_jointe_mime: null,
    statut, date_creation: dt(d._date), date_maj: dt(d._date), date_cloture: null,
  };
  const closed = buildThread('demande', row, owner);
  if (closed) row.date_cloture = dt(closed);
  row.date_maj = row.date_cloture ?? row.date_creation;
  return row;
});

// Réclamations
const catWeights = [['CONDITIONS_TRAVAIL', 18], ['EQUIPEMENT', 16], ['PAIE', 14], ['ORGANISATION', 14], ['SECURITE', 14], ['RESPONSABLE_HIERARCHIQUE', 12], ['HARCELEMENT', 4], ['AUTRE', 8]];
const urgenceParCategorie = {
  SECURITE: [['MOYEN', 2], ['ELEVE', 4], ['CRITIQUE', 3]],
  HARCELEMENT: [['ELEVE', 3], ['CRITIQUE', 4]],
  RESPONSABLE_HIERARCHIQUE: [['MOYEN', 4], ['ELEVE', 4], ['CRITIQUE', 1]],
  default: [['FAIBLE', 3], ['MOYEN', 5], ['ELEVE', 2], ['CRITIQUE', 0.4]],
};

const reclamations = numbered('REC', Array.from({ length: 96 }, () => {
  const categorie = weighted(catWeights);
  const [objet, description] = pick(RECLAMATIONS[categorie]);
  return { _date: randomDate(), categorie, objet, description };
}));

// L'exemple du cahier des charges : Production / Sousse, sécurité, critique, récent
const exemple = reclamations[reclamations.length - 3];
Object.assign(exemple, {
  categorie: 'SECURITE',
  objet: 'Non-respect des consignes de sécurité',
  description: 'Le responsable ne respecte pas les consignes de sécurité.',
  _forceOwner: employees.find((e) => e.departement === 'Production' && e.site === 'Sousse'),
  _forceUrgence: 'CRITIQUE',
});

const reclamationRows = reclamations.map((r) => {
  const owner = r._forceOwner ?? pick(employees);
  const niveau = r._forceUrgence ?? weighted(urgenceParCategorie[r.categorie] ?? urgenceParCategorie.default);
  const confidentielle = r.categorie === 'HARCELEMENT' || (r.categorie === 'RESPONSABLE_HIERARCHIQUE' && rand() < 0.6) || rand() < 0.1 ? 1 : 0;
  const statut = r._forceUrgence ? 'EN_COURS' : statusFor(r._date, 'reclamation');
  const row = {
    id: r.id, numero_reclamation: r._numero, numero: r._numero, user_id: owner.id, categorie: r.categorie,
    objet: r.objet, description: r.description, niveau_urgence: niveau, confidentielle, statut,
    date_creation: dt(r._date), date_maj: dt(r._date), date_cloture: null,
  };
  const closed = buildThread('reclamation', row, owner);
  if (closed) row.date_cloture = dt(closed);
  row.date_maj = row.date_cloture ?? row.date_creation;

  // Notifications Direction pour les réclamations critiques (anonymisées)
  if (niveau === 'CRITIQUE') {
    const orga = confidentielle
      ? `Département ${owner.departement} · Site ${owner.site}`
      : `Service ${owner.service} · Département ${owner.departement} · Site ${owner.site}`;
    for (const d of dirUsers) {
      notifications.push({
        user_id: d.id, type: 'RECLAMATION_CRITIQUE', titre: `Réclamation critique ${r._numero}`,
        message: `${{ SECURITE: 'Sécurité', HARCELEMENT: 'Harcèlement', RESPONSABLE_HIERARCHIQUE: 'Responsable hiérarchique' }[r.categorie] ?? r.categorie} — ${orga}`,
        lien: `/direction/reclamation/?id=${r.id}`, lu: (TODAY - r._date) / 86400000 > 20 ? 1 : 0, date_creation: row.date_creation,
      });
    }
  }
  return row;
});

// Suggestions
const suggestions = numbered('SUG', SUGGESTIONS.map(([theme, objet, description]) => ({ _date: randomDate(), theme, objet, description })));
const suggestionRows = suggestions.map((s) => {
  const owner = pick(employees);
  const statut = statusFor(s._date, 'suggestion');
  const row = {
    id: s.id, numero_suggestion: s._numero, numero: s._numero, user_id: owner.id, theme: s.theme, objet: s.objet,
    description: s.description, statut, date_creation: dt(s._date), date_maj: dt(s._date), date_cloture: null,
  };
  const closed = buildThread('suggestion', row, owner);
  if (closed) row.date_cloture = dt(closed);
  row.date_maj = row.date_cloture ?? row.date_creation;
  return row;
});

// Notifications RH : tickets des 10 derniers jours
const recent = [
  ...demandeRows.map((d) => ['demande RH', 'demande', d]),
  ...reclamationRows.map((r) => ['réclamation', 'reclamation', r]),
  ...suggestionRows.map((s) => ['suggestion', 'suggestion', s]),
].filter(([, , t]) => (TODAY - new Date(t.date_creation)) / 86400000 <= 10);
for (const [label, p, t] of recent) {
  for (const rh of rhUsers) {
    notifications.push({
      user_id: rh.id, type: `NOUVELLE_${p.toUpperCase()}`,
      titre: `${t.niveau_urgence === 'CRITIQUE' ? 'CRITIQUE — ' : ''}Nouvelle ${label} ${t.numero}`,
      message: t.objet, lien: `/rh/ticket/?kind=${p}&id=${t.id}`, lu: t.statut === 'NOUVEAU' ? 0 : 1, date_creation: t.date_creation,
    });
  }
}

// Journal d'audit : quelques connexions récentes
const audits = [];
for (const u of [...rhUsers, ...dirUsers, ...employees.slice(0, 8)]) {
  const d = workHours(addHours(TODAY, -24 * (1 + Math.floor(rand() * 6))));
  audits.push({ user_id: u.id, action: 'CONNEXION', entite: null, entite_id: null, ip: `10.10.${Math.floor(rand() * 5)}.${10 + Math.floor(rand() * 200)}`, user_agent: 'Mozilla/5.0 (seed)', details: null, date_creation: dt(d) });
  u.derniere_connexion = dt(d);
}

// ---------------------------------------------------------------- Questionnaire de satisfaction
// Anonymat : les réponses ne portent pas d'user_id, et sont mélangées avant insertion.
const Q_MOYENNES = [4.1, 3.7, 3.6, 2.9, 3.1, 3.5, 3.9, 3.2, 3.4, 2.6, 2.7]; // Q11 (inversée) : « j'ai pensé à partir »
const campagnes = [
  { id: 1, titre: 'Baromètre social — Décembre 2025', date_debut: '2025-12-01', date_fin: '2025-12-31', statut: 'CLOTUREE', created_by: 1, created_at: '2025-11-28 10:00:00', n: 24, delta: 0 },
  { id: 2, titre: 'Baromètre social — Septembre 2026', date_debut: '2026-09-08', date_fin: '2026-10-15', statut: 'OUVERTE', created_by: 1, created_at: '2026-09-07 09:30:00', n: 14, delta: 0.25 },
];
const COMMENTAIRES_QSP = [
  'Merci pour ce questionnaire. Il faudrait plus de communication sur les critères de promotion.',
  "L'ambiance est bonne dans l'équipe mais la charge de travail est très forte en fin de mois.",
  'Je souhaite plus de formations pour évoluer.',
  "La climatisation de l'atelier est un vrai problème en été.",
  'Très content du nouveau portail WORKVOICE !',
  'Les horaires du bus du personnel ne sont pas adaptés à l\'équipe de nuit.',
];
const qParticipations = [];
const qReponses = [];
const qDetails = [];
const uuid = () => 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
  const r = Math.floor(rand() * 16);
  return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
});
const note = (moy) => Math.min(5, Math.max(1, Math.round(moy + (rand() - 0.5) * 2.6)));

for (const c of campagnes) {
  // WM1001 (compte de démo) ne participe pas : il peut tester le questionnaire lui-même
  const pool = employees.filter((e) => e.matricule !== 'WM1001').sort(() => rand() - 0.5).slice(0, c.n);
  const start = new Date(`${c.date_debut}T09:00:00`);
  const end = c.statut === 'OUVERTE' ? addHours(TODAY, -24) : new Date(`${c.date_fin}T17:00:00`);
  const rows = pool.map((e) => {
    const day = dt(new Date(start.getTime() + rand() * (end - start))).slice(0, 10);
    qParticipations.push({ campagne_id: c.id, user_id: e.id, date_participation: day });
    const id = uuid();
    Q_MOYENNES.forEach((m, i) => qDetails.push({ reponse_id: id, question_id: i + 1, note: note(i === 10 ? m - c.delta : m + c.delta) }));
    return { id, campagne_id: c.id, service: e.service, departement: e.departement, site: e.site, date_soumission: day, commentaire: rand() < 0.3 ? pick(COMMENTAIRES_QSP) : null };
  });
  qReponses.push(...rows.sort((a, b) => a.id.localeCompare(b.id)));
}
for (const e of employees) {
  notifications.push({
    user_id: e.id, type: 'QUESTIONNAIRE_OUVERT', titre: 'Questionnaire de satisfaction',
    message: '« Baromètre social — Septembre 2026 » est ouvert. Votre avis compte : 2 minutes, réponses anonymes.',
    lien: '/employe/questionnaire/', lu: qParticipations.some((p) => p.campagne_id === 2 && p.user_id === e.id) ? 1 : 0,
    date_creation: '2026-09-08 08:00:00',
  });
}

// ---------------------------------------------------------------- Écriture du fichier
comments.sort((a, b) => a.date_creation.localeCompare(b.date_creation));
notifications.sort((a, b) => a.date_creation.localeCompare(b.date_creation));

let sql = `-- =====================================================================
--  WORKVOICE — 03_seed.sql — Jeu de données de démonstration
--  Généré par backend/scripts/generate-seed.js — ne pas modifier à la main.
--
--  Mot de passe de TOUS les comptes : ${DEMO_PASSWORD}
--    RH001  Sana Ben Ammar    (RH)
--    RH002  Karim Trabelsi    (RH)
--    DG001  Hichem Gharbi     (Direction)
--    DG002  Leila Mansour     (Direction)
--    WM1001 Amira Hammami     (Employé — Confection, Production, Sousse)
--    WM1002 … WM${1000 + users.filter((u) => u.role === 'EMPLOYE').length} (Employés ; le dernier est désactivé)
-- =====================================================================

USE workvoice;
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

`;

sql += insert('users',
  ['id', 'matricule', 'nom', 'prenom', 'email', 'telephone', 'service', 'departement', 'site', 'role', 'password', 'actif', 'derniere_connexion', 'created_at'],
  users);
sql += insert('demandes',
  ['id', 'numero_demande', 'user_id', 'type_demande', 'objet', 'description', 'piece_jointe', 'piece_jointe_nom', 'piece_jointe_mime', 'statut', 'date_creation', 'date_maj', 'date_cloture'],
  demandeRows);
sql += insert('reclamations',
  ['id', 'numero_reclamation', 'user_id', 'categorie', 'objet', 'description', 'niveau_urgence', 'confidentielle', 'statut', 'date_creation', 'date_maj', 'date_cloture'],
  reclamationRows);
sql += insert('suggestions',
  ['id', 'numero_suggestion', 'user_id', 'theme', 'objet', 'description', 'statut', 'date_creation', 'date_maj', 'date_cloture'],
  suggestionRows);
sql += insert('commentaires', ['demande_id', 'reclamation_id', 'suggestion_id', 'user_id', 'message', 'date_creation'], comments);
sql += insert('notifications', ['user_id', 'type', 'titre', 'message', 'lien', 'lu', 'date_creation'], notifications);
sql += insert('audit_logs', ['user_id', 'action', 'entite', 'entite_id', 'ip', 'user_agent', 'details', 'date_creation'], audits);
sql += insert('sequences', ['prefixe', 'annee', 'dernier'], [
  { prefixe: 'DEM', annee: 2026, dernier: demandeRows.length },
  { prefixe: 'REC', annee: 2026, dernier: reclamationRows.length },
  { prefixe: 'SUG', annee: 2026, dernier: suggestionRows.length },
]);
sql += insert('questionnaire_campagnes', ['id', 'titre', 'date_debut', 'date_fin', 'statut', 'created_by', 'created_at'], campagnes);
sql += insert('questionnaire_participations', ['campagne_id', 'user_id', 'date_participation'], qParticipations);
sql += insert('questionnaire_reponses', ['id', 'campagne_id', 'service', 'departement', 'site', 'date_soumission', 'commentaire'], qReponses);
sql += insert('questionnaire_reponses_detail', ['reponse_id', 'question_id', 'note'], qDetails);
sql += 'SET FOREIGN_KEY_CHECKS = 1;\n';

fs.writeFileSync(OUT, sql, 'utf8');
console.info(`✔ ${path.relative(process.cwd(), OUT)} généré :`,
  `${users.length} utilisateurs, ${demandeRows.length} demandes, ${reclamationRows.length} réclamations,`,
  `${suggestionRows.length} suggestions, ${comments.length} commentaires, ${notifications.length} notifications,`,
  `${qReponses.length} réponses au questionnaire.`);
