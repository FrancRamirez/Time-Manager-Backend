import { createPool, type Pool } from "mysql2/promise";
import type { ResultSetHeader } from "mysql2";
import { timed } from "./timing";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = createPool({
      host: process.env.TIDB_HOST,
      port: Number(process.env.TIDB_PORT ?? 4000),
      user: process.env.TIDB_USER,
      password: process.env.TIDB_PASSWORD,
      database: process.env.TIDB_DATABASE ?? "time_manager",
      // TiDB Cloud Starter exige TLS. Node ya trae los certificados raíz necesarios.
      ssl: { minVersion: "TLSv1.2", rejectUnauthorized: true },
      connectionLimit: 5,
      enableKeepAlive: true,
      timezone: "Z",
    });
  }
  return pool;
}

/** SELECT: devuelve las filas tipadas. */
export async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const [rows] = await timed("db", () => getPool().query(sql, params));
  return rows as T[];
}

/** INSERT / UPDATE / DELETE. */
export async function exec(sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [result] = await timed("db", () => getPool().query<ResultSetHeader>(sql, params));
  return result;
}
