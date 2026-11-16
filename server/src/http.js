import { ZodError } from 'zod';
import { HttpError } from './errors.js';

export const wrap = (handler) => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(next);
};

export function parse(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const message = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'value'}: ${issue.message}`)
      .join('; ');
    throw new HttpError(message, 400);
  }
  return result.data;
}

export function pageQuery(query) {
  const page = Math.max(1, Number.parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || 20));
  return { page, limit, skip: (page - 1) * limit };
}

export function sendList(res, data, total, page, limit, extra = {}) {
  res.json({
    data,
    meta: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)), ...extra },
  });
}

export function sortFrom(query, allowed, fallback = '-createdAt') {
  const raw = String(query.sort || '');
  const descending = raw.startsWith('-');
  const field = descending ? raw.slice(1) : raw;
  if (!allowed.includes(field)) return fallback;
  return descending ? `-${field}` : field;
}

export function searchRegex(value) {
  const text = String(value || '').trim().slice(0, 80);
  if (text.length < 1) return null;
  return new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
}

export function errorMiddleware(error, req, res, _next) {
  if (error instanceof ZodError) {
    return res.status(400).json({ error: 'Invalid request' });
  }
  if (error instanceof HttpError) {
    return res.status(error.status).json({ error: error.message, details: error.details });
  }
  if (error?.code === 11000) {
    const field = Object.keys(error.keyPattern || {})[0] || 'value';
    return res.status(409).json({ error: `A record with this ${field} already exists` });
  }
  if (error?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Request body must be JSON' });
  }
  console.error(error);
  return res.status(500).json({ error: 'Something went wrong while processing that request' });
}

export function asyncAudit(promise) {
  promise.catch((error) => console.error('Audit log failed', error));
}
