import {
  downloadFile,
  fileDownloadInfo,
  getHFHubCachePath,
  getRepoFolderName,
} from "@huggingface/hub";
import { createHash } from "node:crypto";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  statSync,
} from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { CatalogModel } from "./catalog.js";

function repositoryCacheDirectory(model: CatalogModel): string {
  return join(
    getHFHubCachePath(),
    getRepoFolderName({ name: model.repository, type: "model" }),
  );
}

function snapshotsDirectory(model: CatalogModel): string {
  return join(repositoryCacheDirectory(model), "snapshots");
}

export type CachedCatalogModel = {
  path: string;
};

/** Find the catalog file in the standard HF cache. Exact pinned-revision paths
 * win, but older `main` downloads are also recognized by size. */
export function findCachedCatalogModel(model: CatalogModel): CachedCatalogModel | undefined {
  const snapshots = snapshotsDirectory(model);
  const revisions = [
    model.revision,
    ...(existsSync(snapshots)
      ? readdirSync(snapshots, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && entry.name !== model.revision)
          .map((entry) => entry.name)
      : []),
  ];

  for (const revision of revisions) {
    const path = join(snapshots, revision, model.filename);
    if (!existsSync(path)) continue;
    try {
      if (statSync(path).size === model.size) return { path };
    } catch {
      // A cache entry can disappear during concurrent HF cache maintenance.
    }
  }
  return undefined;
}

async function sha256(path: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path, { signal })) hash.update(chunk);
  return hash.digest("hex");
}

async function discardCorruptCacheEntry(path: string): Promise<void> {
  const blobPath = await realpath(path).catch(() => undefined);
  await unlink(path).catch(() => undefined);
  if (blobPath && blobPath !== path) await unlink(blobPath).catch(() => undefined);
}

export async function verifyCatalogModel(
  path: string,
  model: CatalogModel,
  signal?: AbortSignal,
): Promise<void> {
  const fileStat = await stat(path);
  if (fileStat.size !== model.size) {
    await discardCorruptCacheEntry(path);
    throw new Error(
      `${model.name} size mismatch: expected ${model.size} bytes, received ${fileStat.size}`,
    );
  }

  const digest = await sha256(path, signal);
  if (digest !== model.sha256) {
    await discardCorruptCacheEntry(path);
    throw new Error(`${model.name} SHA-256 mismatch; corrupt cached bytes were removed`);
  }
}

type DownloadProgress = {
  downloaded: number;
  total: number;
};

async function exists(path: string): Promise<boolean> {
  return lstat(path).then(
    () => true,
    () => false,
  );
}

async function createCacheLink(blobPath: string, pointerPath: string): Promise<void> {
  await rm(pointerPath, { force: true });
  try {
    await symlink(relative(dirname(pointerPath), blobPath), pointerPath);
  } catch {
    // Match Hugging Face's Windows fallback when symlinks are unavailable.
    await copyFile(blobPath, pointerPath);
  }
}

export async function downloadCatalogModel(
  model: CatalogModel,
  options: {
    signal?: AbortSignal;
    onProgress?: (progress: DownloadProgress) => void;
  } = {},
): Promise<string> {
  const { signal, onProgress } = options;
  signal?.throwIfAborted();

  const storage = repositoryCacheDirectory(model);
  const pointerPath = join(storage, "snapshots", model.revision, model.filename);
  if (await stat(pointerPath).then((value) => value.size === model.size, () => false)) {
    onProgress?.({ downloaded: model.size, total: model.size });
    return pointerPath;
  }

  const token = process.env.HF_TOKEN?.trim();
  const credentials = token ? { accessToken: token } : {};
  const abortingFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, signal });
  const info = await fileDownloadInfo({
    repo: model.repository,
    path: model.filename,
    revision: model.revision,
    fetch: abortingFetch,
    ...credentials,
  });
  if (!info) throw new Error(`Could not find ${model.filename} on Hugging Face`);
  if (info.size !== model.size) {
    throw new Error(
      `${model.name} size mismatch: catalog has ${model.size} bytes, Hugging Face reports ${info.size}`,
    );
  }

  const etag = (info.xet?.hash ?? info.etag).replace(/^W\//, "").replace(/^"|"$/g, "");
  const blobPath = join(storage, "blobs", etag);
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  if (await exists(blobPath)) {
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: model.size, total: model.size });
    return pointerPath;
  }

  const incompletePath = `${blobPath}.incomplete`;
  const blob = await downloadFile({
    repo: model.repository,
    path: model.filename,
    revision: model.revision,
    downloadInfo: info,
    fetch: abortingFetch,
    ...credentials,
  });
  if (!blob) throw new Error(`Could not download ${model.filename}`);

  let downloaded = 0;
  let lastReport = 0;
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastReport >= 100 || downloaded === blob.size) {
        lastReport = now;
        onProgress?.({ downloaded, total: blob.size });
      }
      callback(null, chunk);
    },
  });

  onProgress?.({ downloaded: 0, total: blob.size });
  try {
    await pipeline(
      Readable.fromWeb(blob.stream() as ReadableStream<Uint8Array>),
      progress,
      createWriteStream(incompletePath),
      { signal },
    );
    signal?.throwIfAborted();
    await rename(incompletePath, blobPath);
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: blob.size, total: blob.size });
    return pointerPath;
  } catch (error) {
    await rm(incompletePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
