import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/** True when Cloudinary has real credentials, so callers can fail with a clear
 *  message instead of a generic 500 from the SDK. */
export function isCloudinaryConfigured(): boolean {
  const { CLOUDINARY_CLOUD_NAME: name, CLOUDINARY_API_KEY: key, CLOUDINARY_API_SECRET: secret } = process.env;
  return !!(name && key && secret && !name.includes('fake') && !key.includes('fake'));
}

export async function uploadToCloudinary(
  buffer: Buffer,
  folder: string,
  filename?: string,
  // 'raw' for anything that is not an image — a PDF put through the image
  // pipeline below comes back mangled or not at all.
  resourceType: 'image' | 'raw' = 'image'
): Promise<string> {
  return new Promise((resolve, reject) => {
    const options: any = { folder, resource_type: resourceType };
    if (resourceType === 'image') {
      options.quality = 'auto:good';
      options.transformation = [{ width: 1200, crop: 'limit' }];
    }
    if (filename) {
      options.public_id = filename;
    }

    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) return reject(error);
      resolve(result!.secure_url);
    });

    stream.end(buffer);
  });
}

export async function deleteFromCloudinary(publicId: string): Promise<void> {
  await cloudinary.uploader.destroy(publicId);
}

export function extractPublicId(url: string): string | null {
  // Extract public_id from Cloudinary URL
  // e.g. https://res.cloudinary.com/xxx/image/upload/v123/tiffinhub/deliveries/abc.jpg -> tiffinhub/deliveries/abc
  const match = url.match(/\/upload\/(?:v\d+\/)?(.+)\.\w+$/);
  return match ? match[1] : null;
}

export { cloudinary };
