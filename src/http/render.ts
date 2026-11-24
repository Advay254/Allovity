import type { Request, RequestHandler, Response } from 'express';
import { capabilities, footerLinks, headerCta, primaryNav } from '../config/nav.js';
import type { AppConfig } from '../config/env.js';
import { site } from '../config/site.js';
import type { AssetResolver } from '../lib/assets.js';
import { icon } from '../lib/icons.js';

export interface PageMeta {
  /** Stable identifier written to <body data-page>. */
  pageId: string;
  title?: string;
  description?: string;
  /** Path such as "/". Omit for pages that must not have a canonical link. */
  canonicalPath?: string;
  /** Path of a social image, for example an asset URL. Defaults to the site image. */
  image?: string;
  noindex?: boolean;
  /** Logical asset name of a page script, for example "pages/home.js". */
  pageScript?: string;
}

/** Template helpers and shared data available to every view. */
export function templateLocals(config: AppConfig, asset: AssetResolver): RequestHandler {
  const absoluteUrl = (path: string): string =>
    new URL(path, `${config.publicSiteUrl}/`).toString();
  return (_req, res, next) => {
    Object.assign(res.locals, {
      site,
      asset,
      icon,
      absoluteUrl,
      nav: primaryNav,
      headerCta,
      footerLinks,
      capabilities,
      year: new Date().getFullYear(),
    });
    next();
  };
}

function renderView(res: Response, view: string, data: Record<string, unknown>): Promise<string> {
  return new Promise((resolve, reject) => {
    res.render(view, data, (error: Error | null, html?: string) =>
      error || html === undefined ? reject(error ?? new Error('Empty render')) : resolve(html),
    );
  });
}

/**
 * Renders a page view inside a layout. EJS has no layouts, so the page is rendered
 * to a string first and then passed to the layout as `body`.
 */
export async function renderPage(
  _req: Request,
  res: Response,
  view: string,
  meta: PageMeta,
  data: Record<string, unknown> = {},
  layout = 'layout',
): Promise<void> {
  const body = await renderView(res, view, { ...data, meta });
  const html = await renderView(res, layout, { ...data, meta, body });
  res.type('html').send(html);
}
