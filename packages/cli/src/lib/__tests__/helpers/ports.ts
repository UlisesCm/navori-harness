import { createServer } from "node:http";

/** A port nobody is listening on: opened to reserve a number, then released. */
export async function deadPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((done) => probe.listen(0, "127.0.0.1", () => done()));
  const address = probe.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((done) => probe.close(() => done()));
  return port;
}
