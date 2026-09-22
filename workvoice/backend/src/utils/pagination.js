import { z } from 'zod';

export const paginationSchema = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
};

export function paginate({ page, pageSize }) {
  return { limit: pageSize, offset: (page - 1) * pageSize };
}

export function paged(data, total, { page, pageSize }) {
  return { data, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) };
}
