import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function fixturePath(name: string): string {
  return path.join(here, "fixtures", name);
}

export async function readFixture(name: string): Promise<Buffer> {
  return readFile(fixturePath(name));
}
