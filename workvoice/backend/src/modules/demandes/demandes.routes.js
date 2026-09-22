import path from 'node:path';
import { env } from '../../config/env.js';
import { removeUploaded, upload } from '../../middlewares/upload.js';
import { validate } from '../../middlewares/validate.js';
import { audit } from '../../utils/audit.js';
import { notFound } from '../../utils/httpError.js';
import { TICKET_KINDS } from '../tickets/tickets.config.js';
import { buildTicketRouter } from '../tickets/tickets.router.js';
import { demandeCreateSchema, idParamSchema } from '../tickets/tickets.schemas.js';
import * as tickets from '../tickets/tickets.service.js';

const cfg = TICKET_KINDS.demande;

export default buildTicketRouter(cfg, (router) => {
  // POST /api/demandes — multipart/form-data (champ fichier : piece_jointe)
  router.post('/', upload.single('piece_jointe'), async (req, res) => {
    let data;
    try {
      data = demandeCreateSchema.parse(req.body ?? {});
    } catch (err) {
      removeUploaded(req.file);
      throw err;
    }

    if (req.file) {
      data.piece_jointe = req.file.filename;
      data.piece_jointe_nom = req.file.originalname.slice(0, 255);
      data.piece_jointe_mime = req.file.mimetype;
    }

    let created;
    try {
      created = await tickets.createTicket(cfg, req.user, data);
    } catch (err) {
      removeUploaded(req.file);
      throw err;
    }

    await audit(req, 'DEMANDE_CREATION', { entite: cfg.table, entiteId: created.id, details: { numero: created.numero } });
    res.status(201).json({ data: created });
  });

  // GET /api/demandes/:id/piece-jointe — auteur ou RH
  router.get('/:id/piece-jointe', validate(idParamSchema, 'params'), async (req, res, next) => {
    const { id } = req.valid.params;
    const file = await tickets.getAttachment(cfg, id, req.user);
    await audit(req, 'PIECE_JOINTE_TELECHARGEMENT', { entite: cfg.table, entiteId: id });
    // basename : aucune traversée de répertoire possible
    const filePath = path.join(env.uploadDir, path.basename(file.stored));
    res.download(filePath, file.original ?? 'piece-jointe', { headers: { 'X-Content-Type-Options': 'nosniff' } }, (err) => {
      if (err && !res.headersSent) next(notFound('Fichier introuvable sur le serveur'));
    });
  });
});
