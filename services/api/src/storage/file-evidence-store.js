import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

function evidencePath(rootDirectory, key) {
  if (typeof key !== "string" || !key.trim()) {
    throw new Error("Evidence key is required");
  }

  const root = resolve(rootDirectory);
  const target = resolve(root, key);
  const pathFromRoot = relative(root, target);
  if (
    pathFromRoot === ""
    || pathFromRoot === ".."
    || pathFromRoot.startsWith(`..${sep}`)
  ) {
    throw new Error("Evidence key must stay inside the evidence root");
  }
  return target;
}

function portableUri(key) {
  return `pasarai-evidence:${Buffer.from(key).toString("base64url")}`;
}

function keyFromPortableUri(uri) {
  if (!uri.startsWith("pasarai-evidence:")) {
    throw new Error("Unsupported evidence URI");
  }
  return Buffer.from(
    uri.slice("pasarai-evidence:".length),
    "base64url",
  ).toString("utf8");
}

function assertMerchantOwnership(key, merchantId) {
  if (!merchantId) throw new Error("merchantId is required");
  const [channel, owner] = key.split(/[\\/]/);
  if (!["telegram", "web"].includes(channel) || owner !== merchantId) {
    throw new Error("Evidence does not belong to the authenticated merchant");
  }
}

function mediaType(path) {
  if (extname(path).toLowerCase() === ".jpg"
    || extname(path).toLowerCase() === ".jpeg") return "image/jpeg";
  if (extname(path).toLowerCase() === ".png") return "image/png";
  if (extname(path).toLowerCase() === ".json") return "application/json";
  if (extname(path).toLowerCase() === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

function evidenceContentConflict(key) {
  const error = new Error(
    `Evidence key already exists with different content: ${key}`,
  );
  error.code = "EVIDENCE_CONTENT_CONFLICT";
  return error;
}

async function publishImmutableEvidence({ target, key, bytes }) {
  const temporaryTarget = `${target}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryTarget, bytes, { flag: "wx" });
    try {
      await link(temporaryTarget, target);
      return;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporaryTarget, { force: true }).catch(() => {});
  }

  const existing = await readFile(target);
  if (!existing.equals(bytes)) {
    throw evidenceContentConflict(key);
  }
}

export function createFileEvidenceStore({
  rootDirectory,
  portableUris = false,
}) {
  if (!rootDirectory) throw new Error("rootDirectory is required");

  return {
    async healthCheck() {
      await mkdir(resolve(rootDirectory), { recursive: true });
      await access(resolve(rootDirectory));
      return { status: "ok" };
    },

    async put({ key, bytes }) {
      const target = evidencePath(rootDirectory, key);
      const content = Buffer.from(bytes);
      await mkdir(dirname(target), { recursive: true });
      await publishImmutableEvidence({ target, key, bytes: content });
      return {
        uri: portableUris ? portableUri(key) : pathToFileURL(target).href,
      };
    },

    async get({ uri, merchantId }) {
      const key = keyFromPortableUri(uri);
      assertMerchantOwnership(key, merchantId);
      const target = evidencePath(rootDirectory, key);
      return {
        bytes: await readFile(target),
        contentType: mediaType(target),
      };
    },
  };
}
