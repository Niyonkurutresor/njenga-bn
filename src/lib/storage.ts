import { randomUUID } from 'node:crypto';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { v2 as cloudinary, type UploadApiResponse } from 'cloudinary';
import { env } from '../config/env.js';

export interface StoredFile {
  url: string;
  /** Driver-specific key used to delete the file later. */
  storageKey: string;
}

export interface StorageDriver {
  put(
    file: { buffer: Buffer; mimeType: string; originalName: string },
    folder: string,
  ): Promise<StoredFile>;
  remove(storageKey: string): Promise<void>;
}

const safeExt = (name: string) =>
  path
    .extname(name)
    .toLowerCase()
    .replace(/[^.a-z0-9]/g, '');

/** Files on local disk, served by Express at /uploads (development / single server). */
const localDriver: StorageDriver = {
  async put(file, folder) {
    const dir = path.resolve(env.UPLOAD_DIR, folder);
    await mkdir(dir, { recursive: true });
    const name = `${randomUUID()}${safeExt(file.originalName)}`;
    await writeFile(path.join(dir, name), file.buffer);
    const key = `${folder}/${name}`;
    return { url: `${env.APP_URL}/uploads/${key}`, storageKey: key };
  },
  async remove(storageKey) {
    await unlink(path.resolve(env.UPLOAD_DIR, storageKey)).catch(() => undefined);
  },
};

let cloudinaryConfigured = false;

/** Cloudinary; images are auto-compressed and resized (FR-OPS-02). */
const cloudinaryDriver: StorageDriver = {
  async put(file, folder) {
    if (!cloudinaryConfigured) {
      cloudinary.config({
        cloud_name: env.CLOUDINARY_CLOUD_NAME,
        api_key: env.CLOUDINARY_API_KEY,
        api_secret: env.CLOUDINARY_API_SECRET,
        secure: true,
      });
      cloudinaryConfigured = true;
    }
    const isImage = file.mimeType.startsWith('image/');
    const result = await new Promise<UploadApiResponse>((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `${env.CLOUDINARY_FOLDER}/${folder}`,
          resource_type: isImage ? 'image' : 'raw',
          ...(isImage
            ? { transformation: [{ width: 1920, height: 1920, crop: 'limit', quality: 'auto' }] }
            : { public_id: `${randomUUID()}${safeExt(file.originalName)}` }),
        },
        (error, res) =>
          error || !res ? reject(error ?? new Error('Upload failed')) : resolve(res),
      );
      stream.end(file.buffer);
    });
    return {
      url: result.secure_url,
      storageKey: `${isImage ? 'image' : 'raw'}:${result.public_id}`,
    };
  },
  async remove(storageKey) {
    const [type, publicId] = storageKey.split(/:(.*)/s);
    if (!publicId) return;
    await cloudinary.uploader.destroy(publicId, {
      resource_type: type === 'raw' ? 'raw' : 'image',
    });
  },
};

export const storage: StorageDriver =
  env.STORAGE_DRIVER === 'cloudinary' ? cloudinaryDriver : localDriver;
