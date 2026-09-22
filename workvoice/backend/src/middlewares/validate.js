/**
 * Valide req[source] avec un schéma zod. Le résultat typé et nettoyé est
 * disponible dans req.valid[source] (req.query est en lecture seule en Express 5).
 * Les erreurs zod sont converties en 422 par errorHandler.
 */
export function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const data = schema.parse(req[source] ?? {});
    req.valid = { ...req.valid, [source]: data };
    if (source === 'body') req.body = data;
    next();
  };
}
