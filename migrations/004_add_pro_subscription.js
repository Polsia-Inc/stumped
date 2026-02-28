module.exports = {
  name: 'add_pro_subscription',
  up: async (client) => {
    // Add pro subscription columns to users table
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS pro BOOLEAN DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS pro_since TIMESTAMP,
      ADD COLUMN IF NOT EXISTS pro_expires TIMESTAMP,
      ADD COLUMN IF NOT EXISTS bio TEXT,
      ADD COLUMN IF NOT EXISTS stripe_customer_id VARCHAR(255),
      ADD COLUMN IF NOT EXISTS stripe_subscription_id VARCHAR(255)
    `);

    // Add indexes for subscription queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_pro ON users(pro) WHERE pro = TRUE`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_users_pro_expires ON users(pro_expires) WHERE pro_expires IS NOT NULL`);
  }
};
