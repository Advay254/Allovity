import { randomBytes } from 'node:crypto';
import pg from 'pg';

const ADMIN_URL =
  process.env.TEST_DATABASE_ADMIN_URL ?? 'postgres://postgres:postgres@127.0.0.1:5432/postgres';

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/** Creates an empty, uniquely named database so every suite starts from nothing. */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `allovity_test_${randomBytes(6).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const url = new URL(ADMIN_URL);
  url.pathname = `/${name}`;
  return {
    url: url.toString(),
    async drop() {
      const client = new pg.Client({ connectionString: ADMIN_URL });
      await client.connect();
      await client.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await client.end();
    },
  };
}
