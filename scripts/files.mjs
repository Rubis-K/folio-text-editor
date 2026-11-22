import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function openFiles(directory) {
  return {
    async put(key, bytes) {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, key), bytes, { flag: 'wx' });
    },
    async get(key) {
      try {
        return { body: await readFile(join(directory, key)) };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async delete(key) {
      await rm(join(directory, key), { force: true });
    },
  };
}
