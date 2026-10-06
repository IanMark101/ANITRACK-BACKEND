import type { ErrorRequestHandler } from 'express';
import { Prisma } from '@prisma/client';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message);
  }
}

export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Please check the submitted fields.',
        details: error.issues.map((issue) => ({
          field: issue.path.join('.'),
          message: issue.message
        }))
      }
    });
  } else if (error instanceof AppError) {
    res.status(error.status).json({ error: { code: error.code, message: error.message } });
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
    res.status(409).json({ error: { code: 'CONFLICT', message: 'This record already exists.' } });
  } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Record not found.' } });
  } else if (error.type === 'entity.too.large') {
    res
      .status(413)
      .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Image must be smaller than 1 MB.' } });
  } else if (error instanceof SyntaxError && 'body' in error) {
    res.status(400).json({ error: { code: 'INVALID_JSON', message: 'Invalid JSON body.' } });
  } else {
    console.error('Request failed:', error.code ?? error.name ?? 'Unknown error');
    res.status(503).json({
      error: {
        code: 'SERVICE_UNAVAILABLE',
        message: 'The service is unavailable. Please try again.'
      }
    });
  }
};
