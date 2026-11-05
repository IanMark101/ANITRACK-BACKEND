// Only callers that successfully created a fresh UUID schema may clean it up.
export async function dropOwnedTestSchema(db, schema, createdByThisRun) {
  if (createdByThisRun !== true || !/^anitrack_(?:test|browser)_[a-f0-9]{32}$/.test(schema))
    throw new Error('Refusing to remove a schema without this test run’s ownership.');
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      // Safe even if PostgreSQL committed before the previous connection was lost.
      await db.$executeRawUnsafe('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
      const remaining = await db.$queryRawUnsafe('SELECT 1 FROM pg_namespace WHERE nspname = $1', schema);
      if (remaining.length) throw new Error('The disposable schema still exists.');
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      console.warn('Retrying isolated-schema cleanup after a database error.');
      await db.$disconnect();
      await new Promise(accept => setTimeout(accept, 1000 * (attempt + 1)));
    }
  }
}
