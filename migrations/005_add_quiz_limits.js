module.exports = {
  name: 'add_quiz_limits',
  up: async (client) => {
    // Add quiz_count to users table to track free tier limits
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS quiz_count INTEGER DEFAULT 0
    `);

    // Update existing users' quiz counts based on their created quizzes
    await client.query(`
      UPDATE users u
      SET quiz_count = (
        SELECT COUNT(*)
        FROM quizzes q
        WHERE q.created_by_user_id = u.id
      )
      WHERE EXISTS (
        SELECT 1 FROM quizzes q WHERE q.created_by_user_id = u.id
      )
    `);

    // Add index for quiz count queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_quiz_count ON users(quiz_count)`);
  }
};
