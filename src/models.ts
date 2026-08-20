import {
  downloadFile,
  fileDownloadInfo,
  getHFHubCachePath,
  getRepoFolderName,
} from "@huggingface/hub";
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import {
  copyFile,
  mkdir,
  rename,
  rm,
  stat,
  symlink,
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

export type CachedCatalogModel = {
  path: string;
};

/** Find the exact catalog revision in the standard Hugging Face cache. */
export function findCachedCatalogModel(model: CatalogModel): CachedCatalogModel | undefined {
  const path = join(
    repositoryCacheDirectory(model),
    "snapshots",
    model.revision,
    model.filename,
  );
  if (!existsSync(path)) return undefined;
  try {
    return statSync(path).size === model.size ? { path } : undefined;
  } catch {
    // A cache entry can disappear during concurrent HF cache maintenance.
    return undefined;
  }
}

type DownloadProgress = {
  downloaded: number;
  total: number;
};

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

  // Match Hugging Face's standard cache key for these LFS-backed model files.
  const etag = info.etag.replace(/^W\//, "").replace(/^"|"$/g, "");
  const blobPath = join(storage, "blobs", etag);
  // The blob key names this exact content (the size was checked against the
  // catalog above), so a blob of any other size is a broken write by another
  // cache user and is replaced by a fresh download.
  const blobUsable = (): Promise<boolean> =>
    stat(blobPath).then((value) => value.size === model.size, () => false);
  await mkdir(dirname(blobPath), { recursive: true });
  await mkdir(dirname(pointerPath), { recursive: true });

  if (await blobUsable()) {
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: model.size, total: model.size });
    return pointerPath;
  }

  // Each process owns its partial file. Concurrent downloads may duplicate work,
  // but cannot overwrite or remove one another's bytes.
  const incompletePath = `${blobPath}.${process.pid}.${randomUUID()}.incomplete`;
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
  const digest = createHash("sha256");
  const progress = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      downloaded += chunk.length;
      digest.update(chunk);
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

    const incompleteStat = await stat(incompletePath);
    if (incompleteStat.size !== model.size || digest.digest("hex") !== model.sha256) {
      throw new Error(`${model.name} verification failed; incomplete bytes were removed`);
    }
    signal?.throwIfAborted();

    if (await blobUsable()) {
      await rm(incompletePath, { force: true });
    } else {
      try {
        // rename() replaces a wrong-size blob left by an interrupted writer.
        await rename(incompletePath, blobPath);
      } catch (error) {
        // Another process may have published the same verified blob first.
        if (!(await blobUsable())) throw error;
        await rm(incompletePath, { force: true });
      }
    }
    await createCacheLink(blobPath, pointerPath);
    onProgress?.({ downloaded: blob.size, total: blob.size });
    return pointerPath;
  } catch (error) {
    await rm(incompletePath, { force: true }).catch(() => undefined);
    throw error;
  }
}
