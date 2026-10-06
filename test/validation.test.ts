import { describe, expect, it } from 'vitest';
import { updateEntrySchema, updateAnimeSchema, createEntrySchema } from '../src/validation.js';

describe('Partial updates and poster validation', () => {
  it('does not insert creation defaults into patch bodies', () => {
    expect(updateEntrySchema.parse({ rating: 9.7 })).toEqual({ rating: 9.7 });
    expect(updateEntrySchema.parse({ isFavorite: false })).toEqual({ isFavorite: false });
    expect(updateAnimeSchema.parse({ title: 'Updated title' })).toEqual({ title: 'Updated title' });
  });
  it('rejects empty and unknown patches', () => {
    expect(updateEntrySchema.safeParse({}).success).toBe(false);
    expect(updateEntrySchema.safeParse({ userId: 'someone-else' }).success).toBe(false);
    expect(updateAnimeSchema.safeParse({}).success).toBe(false);
  });
  it('accepts safe posters and rejects active or oversized payloads', () => {
    const input = { title: 'Anime', genre: 'Action' };
    expect(
      createEntrySchema.safeParse({ ...input, image: 'https://example.test/poster.jpg' }).success
    ).toBe(true);
    expect(createEntrySchema.safeParse({ ...input, image: 'javascript:alert(1)' }).success).toBe(
      false
    );
    expect(
      createEntrySchema.safeParse({ ...input, image: 'data:image/svg+xml;base64,PHN2Zz4=' }).success
    ).toBe(false);
    expect(
      createEntrySchema.safeParse({
        ...input,
        image: 'data:image/png;base64,' + Buffer.alloc(1048577).toString('base64')
      }).success
    ).toBe(false);
  });
});
