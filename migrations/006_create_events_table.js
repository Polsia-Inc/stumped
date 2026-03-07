module.exports = {
  name: 'create_events_table',
  up: async (client) => {
    // Check if events table exists
    const tableExists = await client.query(`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_name = 'events'
      )
    `);

    if (!tableExists.rows[0].exists) {
      // Create events table if it doesn't exist
      await client.query(`
        CREATE TABLE events (
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
    } else {
      // Table exists - check if visitor_id column exists and add if missing
      const columnExists = await client.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.columns
          WHERE table_name = 'events' AND column_name = 'visitor_id'
        )
      `);

      if (!columnExists.rows[0].exists) {
        await client.query(`ALTER TABLE events ADD COLUMN visitor_id VARCHAR(255)`);
      }

      // Check and add other columns if missing
      const columns = [
        { name: 'event_type', type: 'VARCHAR(100)' },
        { name: 'page_path', type: 'TEXT' },
        { name: 'referrer', type: 'TEXT' },
        { name: 'user_agent', type: 'TEXT' },
        { name: 'ip_address', type: 'INET' },
        { name: 'metadata', type: 'JSONB DEFAULT \'{}\'::jsonb' }
      ];

      for (const col of columns) {
        const colExists = await client.query(`
          SELECT EXISTS (
            SELECT FROM information_schema.columns
            WHERE table_name = 'events' AND column_name = $1
          )
        `, [col.name]);

        if (!colExists.rows[0].exists) {
          await client.query(`ALTER TABLE events ADD COLUMN ${col.name} ${col.type}`);
        }
      }
    }

    // Indexes for fast queries (always try to create - IF NOT EXISTS handles duplicates)
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_visitor_id ON events(visitor_id)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_event_type ON events(event_type)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_created_at ON events(created_at)`);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_events_type_time ON events(event_type, created_at)`);
  }
};
