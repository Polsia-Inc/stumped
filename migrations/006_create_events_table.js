module.exports = {
  name: 'create_events_table',
  up: async (client) => {
    // Events table
    await client.query(`
      CREATE TABLE IF NOT EXISTS events (
        id SERIAL PRIMARY KEY,
        visitor_id VARCHAR(255) NOT NULL,
        event_type VARCHAR(100) NOT NULL,
        page_path TEXT,
        referrer TEXT,
        user_agent TEXT,
        ip_address INET,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes for fast queries
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_visitor_id ON events(visitor_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, created_at)`);
  }
};
