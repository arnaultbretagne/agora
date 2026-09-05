// Controllable database clock: engine lease and due decisions read time only through an
// injectable SQL expression. Production uses `now()`; tests use `agora_test.now()`, which is real
// time plus an offset the test advances, so lease expiry and backoff are driven without sleeping.
import type pg from 'pg'

export const TEST_NOW_SQL = 'agora_test.now()'

export async function installTestClock(pool: pg.Pool): Promise<void> {
  await pool.query(`
    CREATE SCHEMA IF NOT EXISTS agora_test;
    CREATE TABLE IF NOT EXISTS agora_test.clock_offset (
      id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
      "offset" interval NOT NULL DEFAULT interval '0'
    );
    INSERT INTO agora_test.clock_offset (id) VALUES (1) ON CONFLICT DO NOTHING;
    CREATE OR REPLACE FUNCTION agora_test.now() RETURNS timestamptz LANGUAGE sql STABLE AS
      $$ SELECT now() + (SELECT "offset" FROM agora_test.clock_offset WHERE id = 1) $$;
    GRANT USAGE ON SCHEMA agora_test TO agora_product, agora_engine;
    GRANT SELECT ON agora_test.clock_offset TO agora_product, agora_engine;
  `)
}

export async function advanceClock(pool: pg.Pool, ms: number): Promise<void> {
  await pool.query('UPDATE agora_test.clock_offset SET "offset" = "offset" + make_interval(secs => $1)', [ms / 1000])
}
