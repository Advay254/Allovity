import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from '../lib/logger.js';
import { renderPage } from './render.js';

export const notFoundHandler: RequestHandler = (req, res, next) => {
  res.status(404).setHeader('Cache-Control', 'no-store');
  renderPage(req, res, 'pages/404', {
    pageId: 'not-found',
    title: 'Page not found',
    description: 'This page does not exist.',
    noindex: true,
  }).catch(next);
};

function clientErrorStatus(error: unknown): number | undefined {
  const status =
    (error as { status?: unknown; statusCode?: unknown })?.status ??
    (error as { statusCode?: unknown })?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

/**
 * Visitors only ever see a generic page and a request reference. Details, including
 * stack traces and SQL errors, go to the server log.
 */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    const log = (res.locals.log as Logger | undefined) ?? logger;
    const clientStatus = clientErrorStatus(error);
    const status = clientStatus ?? 500;

    if (clientStatus) {
      log.warn('Request rejected', { status, err: error });
    } else {
      log.error('Unhandled error', { err: error, method: req.method });
    }

    res.status(status).setHeader('Cache-Control', 'no-store');
    const copy = clientStatus
      ? {
          code: status,
          heading: 'That request could not be processed.',
          message: 'Check the address and try again.',
        }
      : {
          code: 500,
          heading: 'Something broke on our side.',
          message: 'The problem has been logged. Try again in a moment.',
        };

    renderPage(
      req,
      res,
      'pages/500',
      {
        pageId: 'error',
        title: 'Something went wrong',
        description: 'An error occurred while loading this page.',
        noindex: true,
      },
      copy,
    ).catch((renderError: unknown) => {
      log.error('Error page failed to render', { err: renderError });
      if (!res.headersSent) res.type('text/plain').send('Something went wrong.');
    });
  };
}
