module.exports = {
  name: 'add_user_accounts',
  up: async (client) => {
    // Check if users table exists
    const tableCheck = await client.query(`
      SELECT EXISTS (
        SELECT FROM pg_tables
        WHERE schemaname = 'public'
        AND tablename = 'users'
      )
    `);

    const usersTableExists = tableCheck.rows[0].exists;

    if (!usersTableExists) {
      // Create users table
      await client.query(`
        CREATE TABLE users (
          id SERIAL PRIMARY KEY,
          email VARCHAR(255) UNIQUE NOT NULL,
          password_hash VARCHAR(255),
          google_id VARCHAR(255) UNIQUE,
          display_name VARCHAR(100) NOT NULL,
          avatar_url TEXT,
          created_at TIMESTAMPTZ DEFAULT NOW(),
          updated_at TIMESTAMPTZ DEFAULT NOW()
        )
      `);

      // Indexes for users
      await client.query(`CREATE INDEX idx_users_email ON users(LOWER(email))`);
      await client.query(`CREATE INDEX idx_users_google_id ON users(google_id)`);
      await client.query(`CREATE INDEX idx_users_display_name ON users(LOWER(display_name))`);
    }

    // Add user ownership to quizzes (nullable for anonymous quizzes)
    await client.query(`
      ALTER TABLE quizzes
      ADD COLUMN IF NOT EXISTS created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_quizzes_user ON quizzes(created_by_user_id)`);

    // Add user link to quiz_attempts (nullable for anonymous attempts)
    await client.query(`
      ALTER TABLE quiz_attempts
      ADD COLUMN IF NOT EXISTS user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_attempts_user ON quiz_attempts(user_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attempts_user_completed ON quiz_attempts(user_id, completed_at DESC)`);

    // Sessions table for express-session
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        sid VARCHAR(255) PRIMARY KEY,
        sess JSON NOT NULL,
        expire TIMESTAMPTZ NOT NULL
      )
    `);

    await client.query(`CREATE INDEX IF NOT EXISTS idx_sessions_expire ON sessions(expire)`);
  }
};
