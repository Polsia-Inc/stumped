exports.up = (pgm) => {
  pgm.createTable('events', {
    id: 'id',
    visitor_id: { type: 'varchar(255)', notNull: true }, // Session-based ID from localStorage
    event_type: { type: 'varchar(100)', notNull: true }, // page_view, quiz_generate_start, etc.
    page_path: { type: 'text' }, // URL path
    referrer: { type: 'text' }, // HTTP referrer
    user_agent: { type: 'text' }, // Browser user agent
    ip_address: { type: 'inet' }, // IP address
    metadata: { type: 'jsonb', default: '{}' }, // Event-specific data (quiz_id, score, etc.)
    created_at: { type: 'timestamp', default: pgm.func('current_timestamp'), notNull: true }
  });

  // Indexes for fast queries
  pgm.createIndex('events', 'visitor_id');
  pgm.createIndex('events', 'event_type');
  pgm.createIndex('events', 'created_at');
  pgm.createIndex('events', ['event_type', 'created_at']); // Composite for dashboard queries
};

exports.down = (pgm) => {
  pgm.dropTable('events');
};
