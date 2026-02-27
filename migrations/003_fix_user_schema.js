module.exports = {
  name: 'fix_user_schema',
  up: async (client) => {
    // Add display_name column if it doesn't exist
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS display_name VARCHAR(100)
    `);

    // Copy data from 'name' to 'display_name' for existing rows
    await client.query(`
      UPDATE users
      SET display_name = name
      WHERE display_name IS NULL AND name IS NOT NULL
    `);

    // Make display_name NOT NULL after data migration
    await client.query(`
      ALTER TABLE users
      ALTER COLUMN display_name SET NOT NULL
    `);

    // Add missing columns from original migration
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS google_id VARCHAR(255) UNIQUE
    `);

    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS avatar_url TEXT
    `);

    // Add indexes for display_name and google_id if they don't exist
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_display_name ON users(LOWER(display_name))`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)`);
  }
};
