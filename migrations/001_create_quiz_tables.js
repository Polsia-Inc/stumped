module.exports = {
  name: 'create_quiz_tables',
  up: async (client) => {
    // Quizzes table
    await client.query(`
      CREATE TABLE IF NOT EXISTS quizzes (
        id SERIAL PRIMARY KEY,
        slug VARCHAR(12) NOT NULL UNIQUE,
        topic VARCHAR(255) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Questions table
    await client.query(`
      CREATE TABLE IF NOT EXISTS questions (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        question_number INTEGER NOT NULL,
        question_text TEXT NOT NULL,
        option_a TEXT NOT NULL,
        option_b TEXT NOT NULL,
        option_c TEXT NOT NULL,
        option_d TEXT NOT NULL,
        correct_option CHAR(1) NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Quiz attempts (leaderboard entries)
    await client.query(`
      CREATE TABLE IF NOT EXISTS quiz_attempts (
        id SERIAL PRIMARY KEY,
        quiz_id INTEGER NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
        player_name VARCHAR(100) NOT NULL,
        score INTEGER NOT NULL DEFAULT 0,
        total_questions INTEGER NOT NULL DEFAULT 10,
        time_taken_seconds INTEGER,
        answers JSONB,
        completed_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes
    await client.query(`CREATE INDEX IF NOT EXISTS idx_questions_quiz_id ON questions(quiz_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attempts_quiz_id ON quiz_attempts(quiz_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_attempts_score ON quiz_attempts(quiz_id, score DESC, time_taken_seconds ASC)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_quizzes_slug ON quizzes(slug)`);
  }
};
