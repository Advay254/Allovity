import express from 'express';

/**
 * Body parsers are not mounted globally. A route that needs one adds it explicitly,
 * so every other route rejects nothing and parses nothing. Limits are small on purpose.
 */
export const jsonBody = express.json({ limit: '10kb', strict: true, type: 'application/json' });
export const formBody = express.urlencoded({ extended: false, limit: '10kb', parameterLimit: 50 });
