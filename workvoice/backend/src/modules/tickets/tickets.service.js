import { query, queryOne, transaction } from '../../config/db.js';
import { LABELS, ROLES, STATUTS_TERMINES } from '../../config/constants.js';
import { conflict, notFound } from '../../utils/httpError.js';
import { nextNumero } from '../../utils/numbering.js';
import { paged, paginate } from '../../utils/pagination.js';
import { notifyRole, notifyUsers } from '../../services/notification.service.js';

const IDENTITY_COLS = 'u.matricule, u.nom, u.prenom, u.email, u.telephone';
const ORGA_COLS = 'u.service, u.departement, u.site';

/** Colonnes communes, avec alias génériques `numero` et `type`. */
const baseCols = (cfg) => `t.*, t.${cfg.numeroCol} AS numero, t.${cfg.typeCol} AS type`;

/**
 * Met en forme un ticket pour l'API : l'identité de l'auteur n'est incluse
 * que pour les RH ; le nom de fichier stocké n'est jamais exposé.
 */
function shapeTicket(cfg, row, { withIdentity }) {
  const { matricule, nom, prenom, email, telephone, service, departement, site, piece_jointe, ...t } = row;
  const ticket = { kind: cfg.kind, ...t };
  if ('confidentielle' in ticket) ticket.confidentielle = Boolean(ticket.confidentielle);
  if (cfg.kind === 'demande') ticket.has_piece_jointe = Boolean(piece_jointe);
  if (withIdentity) {
    ticket.auteur = { matricule, nom, prenom, email, telephone, service, departement, site };
  }
  return ticket;
}

async function loadRaw(cfg, id) {
  const row = await queryOne(
    `SELECT ${baseCols(cfg)}, ${IDENTITY_COLS}, ${ORGA_COLS}
     FROM ${cfg.table} t JOIN users u ON u.id = t.user_id
     WHERE t.id = ?`,
    [id],
  );
  if (!row) throw notFound(`${cfg.labelCap} introuvable`);
  return row;
}

/**
 * Charge un ticket en vérifiant les droits : RH ou auteur uniquement.
 * Un non-autorisé reçoit 404 (et non 403) pour ne pas révéler l'existence du ticket.
 */
async function loadForViewer(cfg, id, viewer) {
  const row = await loadRaw(cfg, id);
  const isRh = viewer.role === ROLES.RH;
  const isOwner = row.user_id === viewer.id;
  if (!isRh && !isOwner) throw notFound(`${cfg.labelCap} introuvable`);
  return { row, isRh, isOwner };
}

async function loadComments(cfg, ticketId, viewer) {
  const rows = await query(
    `SELECT c.id, c.message, c.date_creation, c.user_id, u.role, u.prenom, u.nom
     FROM commentaires c JOIN users u ON u.id = c.user_id
     WHERE c.${cfg.commentFk} = ?
     ORDER BY c.date_creation, c.id`,
    [ticketId],
  );
  const viewerIsRh = viewer.role === ROLES.RH;
  return rows.map((c) => ({
    id: c.id,
    message: c.message,
    date_creation: c.date_creation,
    est_moi: c.user_id === viewer.id,
    auteur: {
      role: c.role,
      // Côté collaborateur, les réponses RH sont signées « Service RH »
      nom: c.role === ROLES.RH && !viewerIsRh ? 'Service RH' : `${c.prenom} ${c.nom}`,
    },
  }));
}

// Liens frontend (routes statiques : l'identifiant passe en paramètre de requête)
const employeeLink = (cfg, id) => `/employe/ticket/?kind=${cfg.kind}&id=${id}`;
const rhLink = (cfg, id) => `/rh/ticket/?kind=${cfg.kind}&id=${id}`;

// ---------------------------------------------------------------------

export async function createTicket(cfg, user, data) {
  const { id, numero } = await transaction(async (conn) => {
    const numero = await nextNumero(conn, cfg.prefixe);
    const [res] = await conn.query(`INSERT INTO ${cfg.table} SET ?`, [
      { ...data, [cfg.numeroCol]: numero, user_id: user.id },
    ]);
    return { id: res.insertId, numero };
  });

  // Les notifications ne contiennent jamais l'identité de l'auteur
  const typeLabel = LABELS[cfg.typeCol]?.[data[cfg.typeCol]] ?? '';
  await notifyRole(
    ROLES.RH,
    {
      type: `NOUVELLE_${cfg.kind.toUpperCase()}`,
      titre: `${data.niveau_urgence === 'CRITIQUE' ? 'CRITIQUE — ' : ''}Nouvelle ${cfg.label} ${numero}`,
      message: `${typeLabel} — ${data.objet}`,
      lien: rhLink(cfg, id),
    },
    { excludeUserId: user.id },
  );

  return { id, numero };
}

export async function listMine(cfg, userId) {
  return query(
    `SELECT t.id, t.${cfg.numeroCol} AS numero, t.${cfg.typeCol} AS type, t.objet, t.statut,
            t.date_creation, t.date_maj, t.date_cloture,
            (SELECT COUNT(*) FROM commentaires c WHERE c.${cfg.commentFk} = t.id) AS nb_commentaires
     FROM ${cfg.table} t
     WHERE t.user_id = ?
     ORDER BY t.date_creation DESC`,
    [userId],
  );
}

export async function getTicket(cfg, id, viewer) {
  const { row, isRh } = await loadForViewer(cfg, id, viewer);
  const ticket = shapeTicket(cfg, row, { withIdentity: isRh });
  ticket.commentaires = await loadComments(cfg, id, viewer);
  return { ticket, identityDisclosed: isRh && row.user_id !== viewer.id };
}

export async function getAttachment(cfg, id, viewer) {
  const { row } = await loadForViewer(cfg, id, viewer);
  if (!row.piece_jointe) throw notFound('Aucune pièce jointe');
  return { stored: row.piece_jointe, original: row.piece_jointe_nom, mime: row.piece_jointe_mime };
}

export async function addComment(cfg, id, viewer, message) {
  const { row, isRh } = await loadForViewer(cfg, id, viewer);
  if (!isRh && row.statut === 'CLOTURE') {
    throw conflict('Ce dossier est clôturé : il ne peut plus recevoir de message');
  }

  const commentId = await transaction(async (conn) => {
    const [res] = await conn.query(
      `INSERT INTO commentaires (${cfg.commentFk}, user_id, message) VALUES (?, ?, ?)`,
      [id, viewer.id, message],
    );
    // Une première réponse RH prend le dossier en charge
    if (isRh && row.statut === 'NOUVEAU') {
      await conn.query(`UPDATE ${cfg.table} SET statut = 'EN_COURS' WHERE id = ?`, [id]);
    }
    return res.insertId;
  });

  if (isRh && row.user_id !== viewer.id) {
    await notifyUsers([row.user_id], {
      type: 'REPONSE_RH',
      titre: `Nouvelle réponse sur ${row.numero}`,
      message: `Le service RH a répondu à votre ${cfg.label} « ${row.objet} ».`,
      lien: employeeLink(cfg, id),
    });
  } else {
    await notifyRole(
      ROLES.RH,
      {
        type: 'REPONSE_COLLABORATEUR',
        titre: `Nouveau message sur ${row.numero}`,
        message: `Le collaborateur a ajouté un message à la ${cfg.label} « ${row.objet} ».`,
        lien: rhLink(cfg, id),
      },
      { excludeUserId: viewer.id, email: false },
    );
  }

  return { id: commentId, statut: isRh && row.statut === 'NOUVEAU' ? 'EN_COURS' : row.statut };
}

export async function changeStatus(cfg, id, viewer, statut, commentaire) {
  const row = await loadRaw(cfg, id);
  const previous = row.statut;

  await transaction(async (conn) => {
    await conn.query(
      `UPDATE ${cfg.table}
       SET statut = ?,
           date_cloture = CASE WHEN ? IN (?) THEN COALESCE(date_cloture, NOW()) ELSE NULL END
       WHERE id = ?`,
      [statut, statut, STATUTS_TERMINES, id],
    );
    if (commentaire) {
      await conn.query(
        `INSERT INTO commentaires (${cfg.commentFk}, user_id, message) VALUES (?, ?, ?)`,
        [id, viewer.id, commentaire],
      );
    }
  });

  if (previous !== statut && row.user_id !== viewer.id) {
    await notifyUsers([row.user_id], {
      type: 'STATUT_MAJ',
      titre: `${row.numero} : ${LABELS.statut[statut]}`,
      message: `Votre ${cfg.label} « ${row.objet} » est passée au statut « ${LABELS.statut[statut]} ».`,
      lien: employeeLink(cfg, id),
    });
  }

  return { previous, statut };
}

/** Liste RH paginée et filtrée, avec identité de l'auteur. */
export async function listForRh(cfg, f) {
  const where = [];
  const params = [];

  if (f.statut) { where.push('t.statut = ?'); params.push(f.statut); }
  if (f.ouverts) { where.push('t.statut NOT IN (?)'); params.push(STATUTS_TERMINES); }
  if (f.type) { where.push(`t.${cfg.typeCol} = ?`); params.push(f.type); }
  if (f.urgence && cfg.kind === 'reclamation') { where.push('t.niveau_urgence = ?'); params.push(f.urgence); }
  if (f.site) { where.push('u.site = ?'); params.push(f.site); }
  if (f.departement) { where.push('u.departement = ?'); params.push(f.departement); }
  if (f.q) {
    where.push(`(t.${cfg.numeroCol} LIKE ? OR t.objet LIKE ? OR u.nom LIKE ? OR u.prenom LIKE ? OR u.matricule LIKE ?)`);
    const like = `%${f.q.replace(/[\\%_]/g, '\\$&')}%`;
    params.push(like, like, like, like, like);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM ${cfg.table} t JOIN users u ON u.id = t.user_id ${whereSql}`;
  const { limit, offset } = paginate(f);

  // Réclamations : les critiques non traitées remontent en premier
  const order = cfg.kind === 'reclamation'
    ? `ORDER BY (t.niveau_urgence = 'CRITIQUE' AND t.statut NOT IN ('RESOLU','CLOTURE')) DESC, t.date_creation DESC`
    : 'ORDER BY t.date_creation DESC';

  const [rows, count] = await Promise.all([
    query(
      `SELECT ${baseCols(cfg)}, ${IDENTITY_COLS}, ${ORGA_COLS},
              (SELECT COUNT(*) FROM commentaires c WHERE c.${cfg.commentFk} = t.id) AS nb_commentaires
       ${from} ${order} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
    ),
    queryOne(`SELECT COUNT(*) AS total ${from}`, params),
  ]);

  return paged(rows.map((r) => shapeTicket(cfg, r, { withIdentity: true })), count.total, f);
}
