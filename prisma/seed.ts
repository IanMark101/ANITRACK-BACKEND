import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcrypt';
import { readFile } from 'node:fs/promises';
import { registerSchema } from '../src/validation.js';

const db = new PrismaClient();
type SeedAnime = {
  slug: string;
  title: string;
  genre: string;
  image: string;
  synopsis: string;
  rating: number;
  status: string;
  isFavorite: boolean;
};
async function seed() {
  const records: SeedAnime[] = JSON.parse(
    await readFile(new URL('./catalog.json', import.meta.url), 'utf8')
  );
  for (const { slug, title, genre, image, synopsis } of records) {
    await db.anime.upsert({
      where: { slug },
      create: { slug, title, genre, image, synopsis },
      update: { title, genre, image, synopsis }
    });
  }
  console.log(`Seeded ${records.length} catalog titles.`);
  if (process.env.SEED_USER_EMAIL && process.env.SEED_USER_PASSWORD) {
    const input = registerSchema.parse({
      name: process.env.SEED_USER_NAME || 'Anime fan',
      email: process.env.SEED_USER_EMAIL,
      password: process.env.SEED_USER_PASSWORD
    });
    const user = await db.user.upsert({
      where: { email: input.email },
      create: {
        name: input.name,
        email: input.email,
        passwordHash: await bcrypt.hash(input.password, 12)
      },
      update: {}
    });
    const statuses = {
      Watching: 'WATCHING',
      Completed: 'COMPLETED',
      'Plan to Watch': 'PLAN_TO_WATCH'
    } as const;
    for (const record of records) {
      const anime = await db.anime.findUniqueOrThrow({ where: { slug: record.slug } });
      await db.watchlistEntry.upsert({
        where: { userId_animeId: { userId: user.id, animeId: anime.id } },
        create: {
          userId: user.id,
          animeId: anime.id,
          rating: record.rating,
          status: statuses[record.status as keyof typeof statuses],
          isFavorite: record.isFavorite
        },
        update: {}
      });
    }
    console.log('Seeded the optional member watchlist. Existing personal changes were preserved.');
  }
}
seed()
  .catch((error) => {
    console.error('Seed failed:', error.code ?? error.name);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
