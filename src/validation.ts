import { z } from 'zod';

export const genres = [
  'Action',
  'Adventure',
  'Comedy',
  'Drama',
  'Fantasy',
  'Romance',
  'Sci-Fi',
  'Slice of Life',
  'Sports',
  'Supernatural'
] as const;
export const statuses = ['Watching', 'Completed', 'Plan to Watch'] as const;
export const email = z.string().trim().toLowerCase().email().max(254);
export const password = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(72)
  .refine((value) => Buffer.byteLength(value, 'utf8') <= 72, 'Password must be at most 72 bytes.');
export const registerSchema = z
  .object({ name: z.string().trim().min(2).max(80), email, password })
  .strict();
export const loginSchema = z.object({ email, password: z.string().min(1).max(256) }).strict();
const poster = z
  .string()
  .max(1_400_000)
  .refine((value) => {
    if (/^\/images\/[a-z0-9-]+\.jpg$/.test(value)) return true;
    if (/^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)) {
      return Buffer.from(value.split(',')[1], 'base64').length <= 1_048_576;
    }
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
    } catch {
      return false;
    }
  }, 'Use a HTTP(S) image URL, a packaged poster, or a JPEG/PNG/WebP under 1 MB.');
const animeFields = z
  .object({
    title: z.string().trim().min(1).max(200),
    genre: z.enum(genres),
    image: poster,
    synopsis: z.string().trim().max(3000)
  })
  .strict();
export const animeSchema = animeFields.extend({
  image: poster.default('/images/komi.jpg'),
  synopsis: animeFields.shape.synopsis.default('')
});
export const updateAnimeSchema = animeFields.partial().refine(
  (value) => Object.keys(value).length > 0,
  'Submit at least one field.'
);
const mutableEntryFields = z.object({
  rating: z.number().min(1).max(10),
  status: z.enum(statuses),
  isFavorite: z.boolean()
});
export const entryFields = z.object({
  rating: z.number().min(1).max(10).default(8.5),
  status: z.enum(statuses).default('Plan to Watch'),
  isFavorite: z.boolean().default(false)
});
export const createEntrySchema = z.union([
  animeSchema.extend(entryFields.shape).strict(),
  entryFields.extend({ animeId: z.string().min(1).max(100) }).strict()
]);
export const updateEntrySchema = mutableEntryFields
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, 'Submit at least one field.');
export const spotlightSchema = z
  .object({ entryId: z.string().min(1).max(100).nullable() })
  .strict();
