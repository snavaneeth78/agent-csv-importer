import type { TestProject } from "vitest/node";

/** Postgres for integration tests: TEST_DATABASE_URL if set, otherwise a testcontainers Postgres 16. */
export default async function setup(project: TestProject) {
  let url = process.env.TEST_DATABASE_URL;
  let stop: (() => Promise<unknown>) | undefined;
  if (!url) {
    const { PostgreSqlContainer } = await import("@testcontainers/postgresql");
    const c = await new PostgreSqlContainer("postgres:16-alpine").start();
    url = c.getConnectionUri();
    stop = () => c.stop();
  }
  project.provide("dbUrl", url);
  return async () => { await stop?.(); };
}

declare module "vitest" {
  export interface ProvidedContext { dbUrl: string }
}
