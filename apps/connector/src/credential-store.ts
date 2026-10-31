import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export class CredentialStore {
  constructor(private agentId: string, private directory = join(homedir(), ".seam", "credentials")) {}

  async get(name: string) {
    try {
      const values = JSON.parse(await readFile(this.filePath(), "utf8")) as Record<string, { value: string }>;
      return values[name]?.value ?? null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async put(name: string, value: string) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let values: Record<string, unknown> = {};
    try { values = JSON.parse(await readFile(this.filePath(), "utf8")); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    values[name] = { value, updatedAt: new Date().toISOString() };
    const temporary = `${this.filePath()}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(values), { mode: 0o600, flag: "w" });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath());
  }

  private filePath() {
    return join(this.directory, `${this.agentId}.json`);
  }
}
