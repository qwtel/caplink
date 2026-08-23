import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repository = fileURLToPath(new URL('..', import.meta.url));

async function readUpstreamSource(path: string) {
  const process = Bun.spawn(['git', 'show', `v4.4.2:${path}`], {
    cwd: repository,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [source, error, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  if (exitCode !== 0) throw new Error(`Unable to load Comlink 4.4.2 ${path}: ${error}`);
  return source;
}

/** Load the exact upstream source represented by this fork's v4.4.2 tag. */
export async function loadUpstreamComlink() {
  const directory = await mkdtemp(join(tmpdir(), 'caplink-comlink-4.4.2-'));
  await Promise.all([
    Bun.write(join(directory, 'comlink.ts'), await readUpstreamSource('src/comlink.ts')),
    Bun.write(join(directory, 'protocol.ts'), await readUpstreamSource('src/protocol.ts')),
  ]);
  return {
    Comlink: await import(pathToFileURL(join(directory, 'comlink.ts')).href),
    cleanup: () => rm(directory, { recursive: true, force: true }),
  };
}
