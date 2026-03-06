const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const session = require('express-session');
const pgSession = require('connect-pg-simple')(session);
const { validatePassword } = require('./lib/password-policy');

const app = express();
const port = process.env.PORT || 3000;

// Fail fast if DATABASE_URL is missing
if (!process.env.DATABASE_URL) {
  console.error('ERROR: DATABASE_URL environment variable is required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  baseURL: process.env.OPENAI_BASE_URL
});

// Trust proxy for Render deployment (enables secure cookies behind proxy)
app.set('trust proxy', 1);

// Session middleware
app.use(session({
  store: new pgSession({
    pool: pool,
    tableName: 'sessions'
  }),
  secret: process.env.SESSION_SECRET || 'stumped-secret-change-in-production',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  }
}));

app.use(express.json());

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Server-side page view tracking middleware (BEFORE static files)
app.use((req, res, next) => {
  // Only track HTML page requests (skip API, static assets)
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !req.path.match(/\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$/i)) {
    const user_agent = req.headers['user-agent'];
    const ip_address = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // Filter out bots
    const BOT_PATTERNS = [
      /bot/i, /crawler/i, /spider/i, /scraper/i, /curl/i, /wget/i,
      /GPTBot/i, /ChatGPT/i, /Claude/i, /Anthropic/i,
      /GoogleBot/i, /Bingbot/i, /Slurp/i, /DuckDuckBot/i,
      /Baiduspider/i, /YandexBot/i, /Sogou/i, /Exabot/i,
      /facebookexternalhit/i, /WhatsApp/i, /Telegram/i,
      /LinkedInBot/i, /TwitterBot/i, /Slack/i, /Discord/i,
      /Amazonbot/i, /AppleBot/i, /Pinterestbot/i,
      /SemrushBot/i, /AhrefsBot/i, /MJ12bot/i, /DotBot/i,
      /PetalBot/i, /Bytespider/i, /DataForSeoBot/i,
      /ZoomBot/i, /ImagesiftBot/i, /Applebot/i,
      /archive.org_bot/i, /ArchiveBot/i, /Uptimebot/i,
      /StatusCake/i, /Pingdom/i, /NewRelic/i, /Datadog/i
    ];

    const isBot = BOT_PATTERNS.some(pattern => pattern.test(user_agent || ''));

    if (!isBot) {
      // Track page view asynchronously (don't block response)
      pool.query(
        `INSERT INTO events (visitor_id, event_type, page_path, referrer, user_agent, ip_address, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        ['server', 'page_view', req.path, req.headers.referer || null, user_agent, ip_address, JSON.stringify({})]
      ).catch(err => {
        // Silently fail - never break page load due to tracking
        console.error('Server-side tracking error:', err);
      });
    }
  }
  next();
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// HELPERS
// ============================================================

function generateSlug() {
  return crypto.randomBytes(4).toString('hex'); // 8 char hex slug
}

// Admin authentication middleware
function requireAdmin(req, res, next) {
  if (req.session.isAdmin) {
    return next();
  }
  res.status(401).json({ error: 'Admin access required' });
}

// Check if user has active Pro subscription
function isProActive(user) {
  if (!user.pro) return false;
  if (!user.pro_expires) return true; // Lifetime pro
  return new Date(user.pro_expires) > new Date();
}

// Pro subscription constants
const PRO_PAYMENT_LINK = 'https://buy.stripe.com/aFafZh3rE35SdAAb5gdk01W';
const PRO_MONTHLY_PRICE = 4;

// ============================================================
// AUTH API
// ============================================================

// Signup
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, displayName } = req.body;

    if (!email || !email.trim()) {
      return res.status(400).json({ error: 'Email is required' });
    }

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    if (!displayName || !displayName.trim()) {
      return res.status(400).json({ error: 'Display name is required' });
    }

    // Validate password
    const passwordCheck = validatePassword(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.errors[0] });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanDisplayName = displayName.trim().substring(0, 100);

    // Check if email exists
    const emailCheck = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      [cleanEmail]
    );

    if (emailCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Check if display name exists
    const nameCheck = await pool.query(
      'SELECT id FROM users WHERE LOWER(display_name) = $1',
      [cleanDisplayName.toLowerCase()]
    );

    if (nameCheck.rows.length > 0) {
      return res.status(400).json({ error: 'Display name already taken' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Create user
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id, email, display_name, created_at`,
      [cleanEmail, passwordHash, cleanDisplayName]
    );

    const user = result.rows[0];

    // Set session
    req.session.userId = user.id;

    // Save session before responding (ensures cookie is set)
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Signup failed. Please try again.' });
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name
        }
      });
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Signup failed. Please try again.' });
  }
});

// Login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Find user
    const result = await pool.query(
      'SELECT id, email, password_hash, display_name FROM users WHERE LOWER(email) = $1',
      [cleanEmail]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = result.rows[0];

    // Check password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);

    if (!passwordMatch) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Set session
    req.session.userId = user.id;

    // Save session before responding (ensures cookie is set)
    req.session.save((err) => {
      if (err) {
        console.error('Session save error:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }

      res.json({
        user: {
          id: user.id,
          email: user.email,
          displayName: user.display_name
        }
      });
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      console.error('Logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

// Get current user
app.get('/api/auth/me', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await pool.query(
      'SELECT id, email, display_name, avatar_url, pro, pro_since, pro_expires, bio, quiz_count FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (result.rows.length === 0) {
      req.session.destroy();
      return res.status(401).json({ error: 'User not found' });
    }

    const user = result.rows[0];
    const proActive = isProActive(user);
    const quizCount = user.quiz_count || 0;
    const remainingQuizzes = proActive ? null : Math.max(0, 3 - quizCount);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        bio: user.bio,
        isPro: proActive,
        proSince: user.pro_since,
        proExpires: user.pro_expires,
        quizCount: quizCount,
        remainingQuizzes: remainingQuizzes
      }
    });
  } catch (err) {
    console.error('Get user error:', err);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// ============================================================
// USER PROFILE API
// ============================================================

// Get user profile by display name
app.get('/api/users/:displayName', async (req, res) => {
  try {
    const { displayName } = req.params;

    // Get user
    const userResult = await pool.query(
      'SELECT id, display_name, avatar_url, created_at, pro, pro_since, pro_expires, bio FROM users WHERE LOWER(display_name) = $1',
      [displayName.toLowerCase()]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const proActive = isProActive(user);

    // Get created quizzes
    const quizzesResult = await pool.query(
      `SELECT q.slug, q.topic, q.created_at,
              COUNT(DISTINCT qa.id) as play_count
       FROM quizzes q
       LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
       WHERE q.created_by_user_id = $1
       GROUP BY q.id, q.slug, q.topic, q.created_at
       ORDER BY q.created_at DESC
       LIMIT 20`,
      [user.id]
    );

    // Get stats
    const statsResult = await pool.query(
      `SELECT
        COUNT(DISTINCT q.id) as quizzes_created,
        COUNT(DISTINCT qa.id) as quizzes_taken,
        COALESCE(AVG(qa.score::float / qa.total_questions * 100), 0) as avg_score_percentage
       FROM users u
       LEFT JOIN quizzes q ON q.created_by_user_id = u.id
       LEFT JOIN quiz_attempts qa ON qa.user_id = u.id
       WHERE u.id = $1`,
      [user.id]
    );

    const stats = statsResult.rows[0];

    res.json({
      user: {
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        joinedAt: user.created_at,
        isPro: proActive,
        bio: user.bio
      },
      stats: {
        quizzesCreated: parseInt(stats.quizzes_created),
        quizzesTaken: parseInt(stats.quizzes_taken),
        avgScore: Math.round(parseFloat(stats.avg_score_percentage))
      },
      quizzes: quizzesResult.rows.map(row => ({
        slug: row.slug,
        topic: row.topic,
        createdAt: row.created_at,
        playCount: parseInt(row.play_count),
        url: `/quiz/${row.slug}`
      }))
    });
  } catch (err) {
    console.error('Get user profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// ============================================================
// EXPLORE FEED API
// ============================================================

// Get public quizzes for Explore feed
app.get('/api/explore', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q.id, q.slug, q.topic, q.created_at,
              u.display_name as creator_name,
              COUNT(DISTINCT qa.id) as play_count
       FROM quizzes q
       LEFT JOIN users u ON u.id = q.created_by_user_id
       LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
       GROUP BY q.id, q.slug, q.topic, q.created_at, u.display_name
       ORDER BY q.created_at DESC
       LIMIT 100`
    );

    res.json({
      quizzes: result.rows.map(row => ({
        slug: row.slug,
        topic: row.topic,
        creatorName: row.creator_name || 'Anonymous',
        playCount: parseInt(row.play_count),
        createdAt: row.created_at,
        url: `/quiz/${row.slug}`
      }))
    });
  } catch (err) {
    console.error('Explore feed error:', err);
    res.status(500).json({ error: 'Failed to load explore feed' });
  }
});

// Get trending quizzes (most played)
app.get('/api/trending', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT q.id, q.slug, q.topic, q.created_at,
              u.display_name as creator_name,
              COUNT(DISTINCT qa.id) as play_count
       FROM quizzes q
       LEFT JOIN users u ON u.id = q.created_by_user_id
       LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
       GROUP BY q.id, q.slug, q.topic, q.created_at, u.display_name
       HAVING COUNT(DISTINCT qa.id) > 0
       ORDER BY play_count DESC, q.created_at DESC
       LIMIT 8`
    );

    res.json({
      quizzes: result.rows.map(row => ({
        slug: row.slug,
        topic: row.topic,
        creatorName: row.creator_name || 'Anonymous',
        playCount: parseInt(row.play_count),
        createdAt: row.created_at,
        url: `/quiz/${row.slug}`
      }))
    });
  } catch (err) {
    console.error('Trending quizzes error:', err);
    res.status(500).json({ error: 'Failed to load trending quizzes' });
  }
});

// ============================================================
// DASHBOARD API
// ============================================================

// Get user's created quizzes
app.get('/api/dashboard/my-quizzes', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const result = await pool.query(
      `SELECT q.id, q.slug, q.topic, q.created_at,
              COUNT(DISTINCT qa.id) as play_count
       FROM quizzes q
       LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
       WHERE q.created_by_user_id = $1
       GROUP BY q.id, q.slug, q.topic, q.created_at
       ORDER BY q.created_at DESC`,
      [req.session.userId]
    );

    res.json({
      quizzes: result.rows.map(row => ({
        id: row.id,
        slug: row.slug,
        topic: row.topic,
        createdAt: row.created_at,
        playCount: parseInt(row.play_count),
        url: `/quiz/${row.slug}`
      }))
    });
  } catch (err) {
    console.error('Get my quizzes error:', err);
    res.status(500).json({ error: 'Failed to load quizzes' });
  }
});

// Get user's quiz history (quizzes they've taken)
app.get('/api/dashboard/quiz-history', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Check Pro status
    const userResult = await pool.query(
      'SELECT pro, pro_expires FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    if (!isProActive(user)) {
      return res.status(403).json({
        error: 'Pro subscription required',
        upgradeUrl: PRO_PAYMENT_LINK
      });
    }

    const result = await pool.query(
      `SELECT qa.id, qa.quiz_id, qa.score, qa.total_questions, qa.time_taken_seconds, qa.completed_at,
              q.slug, q.topic
       FROM quiz_attempts qa
       JOIN quizzes q ON q.id = qa.quiz_id
       WHERE qa.user_id = $1
       ORDER BY qa.completed_at DESC
       LIMIT 50`,
      [req.session.userId]
    );

    res.json({
      history: result.rows.map(row => ({
        id: row.id,
        quizId: row.quiz_id,
        slug: row.slug,
        topic: row.topic,
        score: row.score,
        total: row.total_questions,
        percentage: Math.round((row.score / row.total_questions) * 100),
        timeTaken: row.time_taken_seconds,
        completedAt: row.completed_at,
        url: `/quiz/${row.slug}`
      }))
    });
  } catch (err) {
    console.error('Get quiz history error:', err);
    res.status(500).json({ error: 'Failed to load quiz history' });
  }
});

// Delete a quiz
app.delete('/api/quizzes/:slug', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { slug } = req.params;

    // Check ownership
    const checkResult = await pool.query(
      'SELECT id, created_by_user_id FROM quizzes WHERE slug = $1',
      [slug]
    );

    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = checkResult.rows[0];

    if (quiz.created_by_user_id !== req.session.userId) {
      return res.status(403).json({ error: 'You can only delete your own quizzes' });
    }

    // Delete quiz (cascade will delete questions and attempts)
    await pool.query('DELETE FROM quizzes WHERE id = $1', [quiz.id]);

    res.json({ message: 'Quiz deleted successfully' });
  } catch (err) {
    console.error('Delete quiz error:', err);
    res.status(500).json({ error: 'Failed to delete quiz' });
  }
});

// ============================================================
// API: Generate a quiz
// ============================================================
app.post('/api/quizzes/generate', async (req, res) => {
  try {
    // REQUIRE AUTHENTICATION - No anonymous quiz creation
    if (!req.session.userId) {
      return res.status(401).json({
        error: 'Please sign up to create quizzes',
        authRequired: true,
        signupUrl: '/signup.html'
      });
    }

    const { topic } = req.body;
    if (!topic || topic.trim().length < 2) {
      return res.status(400).json({ error: 'Topic must be at least 2 characters' });
    }

    const cleanTopic = topic.trim().substring(0, 200);

    // CHECK QUIZ LIMITS FOR FREE USERS
    const userResult = await pool.query(
      'SELECT quiz_count, pro, pro_expires FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];
    const proActive = isProActive(user);
    const quizCount = user.quiz_count || 0;

    // Free users: limited to 3 quizzes
    if (!proActive && quizCount >= 3) {
      return res.status(403).json({
        error: 'Free users can create up to 3 quizzes. Upgrade to Pro for unlimited quiz creation.',
        upgradeRequired: true,
        upgradeUrl: PRO_PAYMENT_LINK,
        remainingQuizzes: 0,
        limit: 3
      });
    }

    // Generate questions with AI
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `You are a trivia quiz generator. Generate exactly 10 multiple-choice trivia questions about the given topic. Each question must have exactly 4 options (A, B, C, D) with exactly one correct answer.

Return ONLY valid JSON in this exact format:
{
  "questions": [
    {
      "question": "What is...?",
      "options": {
        "A": "First option",
        "B": "Second option",
        "C": "Third option",
        "D": "Fourth option"
      },
      "correct": "B"
    }
  ]
}

Rules:
- Questions should range from easy to hard
- Options should be plausible (no joke answers)
- Correct answers should be distributed across A, B, C, D (not all the same)
- Questions should be specific and factual, not opinion-based
- Keep questions concise (under 150 characters)
- Keep options concise (under 80 characters each)`
        },
        {
          role: 'user',
          content: `Generate a 10-question trivia quiz about: ${cleanTopic}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      temperature: 0.8
    });

    const aiResponse = JSON.parse(completion.choices[0].message.content);

    if (!aiResponse.questions || aiResponse.questions.length < 10) {
      return res.status(500).json({ error: 'AI did not generate enough questions. Try again.' });
    }

    const questions = aiResponse.questions.slice(0, 10);

    // Save to database
    const slug = generateSlug();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const quizResult = await client.query(
        'INSERT INTO quizzes (slug, topic, created_by_user_id) VALUES ($1, $2, $3) RETURNING id, slug',
        [slug, cleanTopic, req.session.userId]
      );
      const quizId = quizResult.rows[0].id;

      for (let i = 0; i < questions.length; i++) {
        const q = questions[i];
        await client.query(
          `INSERT INTO questions (quiz_id, question_number, question_text, option_a, option_b, option_c, option_d, correct_option)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [quizId, i + 1, q.question, q.options.A, q.options.B, q.options.C, q.options.D, q.correct]
        );
      }

      // INCREMENT QUIZ COUNT FOR FREE USERS
      await client.query(
        'UPDATE users SET quiz_count = quiz_count + 1 WHERE id = $1',
        [req.session.userId]
      );

      await client.query('COMMIT');

      console.log(`Quiz created successfully: slug=${slug}, topic="${cleanTopic}", questions=${questions.length}, userId=${req.session.userId}`);

      // Calculate remaining quizzes for free users
      const updatedUser = await pool.query(
        'SELECT quiz_count, pro, pro_expires FROM users WHERE id = $1',
        [req.session.userId]
      );
      const newQuizCount = updatedUser.rows[0].quiz_count;
      const isPro = isProActive(updatedUser.rows[0]);
      const remainingQuizzes = isPro ? null : Math.max(0, 3 - newQuizCount);

      res.json({
        slug,
        topic: cleanTopic,
        questionCount: questions.length,
        url: `/quiz/${slug}`,
        remainingQuizzes: remainingQuizzes,
        isPro: isPro
      });
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('Quiz generation error:', err);
    res.status(500).json({ error: 'Failed to generate quiz. Please try again.' });
  }
});

// ============================================================
// API: Get quiz (without correct answers - for players)
// ============================================================
app.get('/api/quizzes/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const quizResult = await pool.query(
      'SELECT id, slug, topic, created_at FROM quizzes WHERE slug = $1',
      [slug]
    );

    if (quizResult.rows.length === 0) {
      console.log(`Quiz not found for slug: ${slug}`);
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizResult.rows[0];

    const questionsResult = await pool.query(
      `SELECT question_number, question_text, option_a, option_b, option_c, option_d
       FROM questions WHERE quiz_id = $1 ORDER BY question_number`,
      [quiz.id]
    );

    // Ensure quiz has questions
    if (questionsResult.rows.length === 0) {
      console.error(`Quiz ${slug} (id: ${quiz.id}) has no questions`);
      return res.status(404).json({ error: 'Quiz data incomplete' });
    }

    // Count attempts
    const countResult = await pool.query(
      'SELECT COUNT(*) as player_count FROM quiz_attempts WHERE quiz_id = $1',
      [quiz.id]
    );

    res.json({
      slug: quiz.slug,
      topic: quiz.topic,
      createdAt: quiz.created_at,
      playerCount: parseInt(countResult.rows[0].player_count),
      questions: questionsResult.rows.map(q => ({
        number: q.question_number,
        question: q.question_text,
        options: {
          A: q.option_a,
          B: q.option_b,
          C: q.option_c,
          D: q.option_d
        }
      }))
    });
  } catch (err) {
    console.error('Get quiz error:', err);
    res.status(500).json({ error: 'Failed to load quiz' });
  }
});

// ============================================================
// API: Submit quiz answers
// ============================================================
app.post('/api/quizzes/:slug/submit', async (req, res) => {
  try {
    const { slug } = req.params;
    const { playerName, answers, timeTaken } = req.body;

    if (!playerName || playerName.trim().length < 1) {
      return res.status(400).json({ error: 'Player name is required' });
    }
    if (!answers || typeof answers !== 'object') {
      return res.status(400).json({ error: 'Answers are required' });
    }

    const quizResult = await pool.query(
      'SELECT id FROM quizzes WHERE slug = $1',
      [slug]
    );

    if (quizResult.rows.length === 0) {
      console.log(`Quiz not found during submit for slug: ${slug}`);
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quizId = quizResult.rows[0].id;

    // Get correct answers
    const correctResult = await pool.query(
      'SELECT question_number, correct_option, question_text, option_a, option_b, option_c, option_d FROM questions WHERE quiz_id = $1 ORDER BY question_number',
      [quizId]
    );

    let score = 0;
    const results = correctResult.rows.map(q => {
      const playerAnswer = answers[q.question_number] || null;
      const isCorrect = playerAnswer === q.correct_option;
      if (isCorrect) score++;

      return {
        number: q.question_number,
        question: q.question_text,
        playerAnswer,
        correctAnswer: q.correct_option,
        isCorrect,
        options: {
          A: q.option_a,
          B: q.option_b,
          C: q.option_c,
          D: q.option_d
        }
      };
    });

    // Save attempt (link to user if logged in)
    const userId = req.session.userId || null;

    await pool.query(
      `INSERT INTO quiz_attempts (quiz_id, player_name, score, total_questions, time_taken_seconds, answers, user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [quizId, playerName.trim().substring(0, 100), score, correctResult.rows.length, timeTaken || null, JSON.stringify(answers), userId]
    );

    res.json({
      score,
      total: correctResult.rows.length,
      percentage: Math.round((score / correctResult.rows.length) * 100),
      results,
      timeTaken: timeTaken || null
    });
  } catch (err) {
    console.error('Submit error:', err);
    res.status(500).json({ error: 'Failed to submit answers' });
  }
});

// ============================================================
// API: Get leaderboard
// ============================================================
app.get('/api/quizzes/:slug/leaderboard', async (req, res) => {
  try {
    const { slug } = req.params;

    const quizResult = await pool.query(
      'SELECT id, topic FROM quizzes WHERE slug = $1',
      [slug]
    );

    if (quizResult.rows.length === 0) {
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quizId = quizResult.rows[0].id;

    const leaderboard = await pool.query(
      `SELECT qa.player_name, qa.score, qa.total_questions, qa.time_taken_seconds, qa.completed_at,
              u.display_name as user_display_name
       FROM quiz_attempts qa
       LEFT JOIN users u ON u.id = qa.user_id
       WHERE qa.quiz_id = $1
       ORDER BY qa.score DESC, qa.time_taken_seconds ASC NULLS LAST
       LIMIT 50`,
      [quizId]
    );

    res.json({
      topic: quizResult.rows[0].topic,
      entries: leaderboard.rows.map((row, i) => ({
        rank: i + 1,
        playerName: row.player_name,
        userDisplayName: row.user_display_name, // For profile link
        score: row.score,
        total: row.total_questions,
        timeTaken: row.time_taken_seconds,
        completedAt: row.completed_at
      }))
    });
  } catch (err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ error: 'Failed to load leaderboard' });
  }
});

// ============================================================
// PRO SUBSCRIPTION API
// ============================================================

// Get Pro upgrade info
app.get('/api/pro/info', (req, res) => {
  res.json({
    monthlyPrice: PRO_MONTHLY_PRICE,
    paymentLink: PRO_PAYMENT_LINK,
    features: [
      'Full quiz history with scores and dates',
      'Custom profile with bio and avatar',
      'Dashboard analytics (play counts, completion rates)',
      'Priority support'
    ]
  });
});

// Initiate Pro upgrade
app.post('/api/pro/upgrade', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const userResult = await pool.query(
      'SELECT email, display_name FROM users WHERE id = $1',
      [req.session.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Build Stripe URL with prefill
    const stripeUrl = new URL(PRO_PAYMENT_LINK);
    stripeUrl.searchParams.set('prefilled_email', user.email);
    stripeUrl.searchParams.set('client_reference_id', `user_${req.session.userId}`);

    res.json({
      paymentUrl: stripeUrl.toString(),
      monthlyPrice: PRO_MONTHLY_PRICE
    });
  } catch (err) {
    console.error('Upgrade error:', err);
    res.status(500).json({ error: 'Failed to initiate upgrade' });
  }
});

// Verify Pro payment and activate subscription
app.post('/api/pro/verify', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    // Customer confirmed payment - activate Pro (trust-based until webhooks)
    const now = new Date();
    const expires = new Date(now);
    expires.setMonth(expires.getMonth() + 1); // 1 month from now

    await pool.query(
      `UPDATE users
       SET pro = TRUE,
           pro_since = COALESCE(pro_since, $1),
           pro_expires = $2
       WHERE id = $3`,
      [now, expires, req.session.userId]
    );

    res.json({
      success: true,
      isPro: true,
      proExpires: expires
    });
  } catch (err) {
    console.error('Verify Pro error:', err);
    res.status(500).json({ error: 'Failed to verify payment' });
  }
});

// Update profile (Pro only for bio)
app.post('/api/profile/update', async (req, res) => {
  try {
    if (!req.session.userId) {
      return res.status(401).json({ error: 'Not authenticated' });
    }

    const { bio } = req.body;

    if (bio !== undefined) {
      // Check Pro status for bio updates
      const userResult = await pool.query(
        'SELECT pro, pro_expires FROM users WHERE id = $1',
        [req.session.userId]
      );

      if (userResult.rows.length === 0) {
        return res.status(404).json({ error: 'User not found' });
      }

      const user = userResult.rows[0];
      if (!isProActive(user)) {
        return res.status(403).json({
          error: 'Pro subscription required for custom bio',
          upgradeUrl: PRO_PAYMENT_LINK
        });
      }

      await pool.query(
        'UPDATE users SET bio = $1 WHERE id = $2',
        [bio.substring(0, 500), req.session.userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// ============================================================
// ADMIN API
// ============================================================

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (!password) {
      return res.status(400).json({ error: 'Password is required' });
    }

    const adminPassword = process.env.ADMIN_PASSWORD || 'admin123';

    if (password !== adminPassword) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Set admin session
    req.session.isAdmin = true;

    req.session.save((err) => {
      if (err) {
        console.error('Admin session save error:', err);
        return res.status(500).json({ error: 'Login failed. Please try again.' });
      }

      res.json({ success: true });
    });
  } catch (err) {
    console.error('Admin login error:', err);
    res.status(500).json({ error: 'Login failed. Please try again.' });
  }
});

// Admin logout
app.post('/api/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  req.session.save((err) => {
    if (err) {
      console.error('Admin logout error:', err);
      return res.status(500).json({ error: 'Logout failed' });
    }
    res.json({ message: 'Logged out successfully' });
  });
});

// Get admin dashboard data
app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  try {
    // User metrics
    const totalUsersResult = await pool.query('SELECT COUNT(*) as count FROM users');
    const totalUsers = parseInt(totalUsersResult.rows[0].count);

    const proUsersResult = await pool.query(
      'SELECT COUNT(*) as count FROM users WHERE pro = TRUE AND (pro_expires IS NULL OR pro_expires > NOW())'
    );
    const proUsers = parseInt(proUsersResult.rows[0].count);

    // Signups over time (last 30 days, grouped by day)
    const signupsOverTimeResult = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    // Quiz metrics
    const totalQuizzesResult = await pool.query('SELECT COUNT(*) as count FROM quizzes');
    const totalQuizzes = parseInt(totalQuizzesResult.rows[0].count);

    const totalAttemptsResult = await pool.query('SELECT COUNT(*) as count FROM quiz_attempts');
    const totalAttempts = parseInt(totalAttemptsResult.rows[0].count);

    const avgScoreResult = await pool.query(`
      SELECT AVG(score::float / total_questions * 100) as avg_score
      FROM quiz_attempts
      WHERE total_questions > 0
    `);
    const avgScore = avgScoreResult.rows[0].avg_score
      ? Math.round(parseFloat(avgScoreResult.rows[0].avg_score))
      : 0;

    // Most popular quizzes
    const popularQuizzesResult = await pool.query(`
      SELECT
        q.slug,
        q.topic,
        COUNT(qa.id) as play_count,
        u.display_name as creator
      FROM quizzes q
      LEFT JOIN quiz_attempts qa ON qa.quiz_id = q.id
      LEFT JOIN users u ON u.id = q.created_by_user_id
      GROUP BY q.id, q.slug, q.topic, u.display_name
      ORDER BY play_count DESC
      LIMIT 10
    `);

    // Quizzes created over time (last 30 days)
    const quizzesOverTimeResult = await pool.query(`
      SELECT
        DATE(created_at) as date,
        COUNT(*) as count
      FROM quizzes
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);

    // System health
    const dbHealthResult = await pool.query('SELECT NOW()');
    const dbHealthy = dbHealthResult.rows.length > 0;

    res.json({
      users: {
        total: totalUsers,
        pro: proUsers,
        free: totalUsers - proUsers,
        signupsOverTime: signupsOverTimeResult.rows.map(row => ({
          date: row.date,
          count: parseInt(row.count)
        }))
      },
      quizzes: {
        total: totalQuizzes,
        totalAttempts,
        avgScore,
        popular: popularQuizzesResult.rows.map(row => ({
          slug: row.slug,
          topic: row.topic,
          playCount: parseInt(row.play_count),
          creator: row.creator || 'Anonymous'
        })),
        createdOverTime: quizzesOverTimeResult.rows.map(row => ({
          date: row.date,
          count: parseInt(row.count)
        }))
      },
      system: {
        dbHealthy,
        uptime: Math.round(process.uptime()),
        nodeVersion: process.version,
        memoryUsage: {
          used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
          total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024)
        }
      }
    });
  } catch (err) {
    console.error('Admin dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard data' });
  }
});

// ============================================================
// EVENT TRACKING
// ============================================================

// Bot user agent patterns to filter out (crawlers, scrapers, bots)
const BOT_PATTERNS = [
  /bot/i, /crawler/i, /spider/i, /scraper/i, /curl/i, /wget/i,
  /GPTBot/i, /ChatGPT/i, /Claude/i, /Anthropic/i,
  /GoogleBot/i, /Bingbot/i, /Slurp/i, /DuckDuckBot/i,
  /Baiduspider/i, /YandexBot/i, /Sogou/i, /Exabot/i,
  /facebookexternalhit/i, /WhatsApp/i, /Telegram/i,
  /LinkedInBot/i, /TwitterBot/i, /Slack/i, /Discord/i,
  /Amazonbot/i, /AppleBot/i, /Pinterestbot/i,
  /SemrushBot/i, /AhrefsBot/i, /MJ12bot/i, /DotBot/i,
  /PetalBot/i, /Bytespider/i, /DataForSeoBot/i,
  /ZoomBot/i, /ImagesiftBot/i, /Applebot/i,
  /archive.org_bot/i, /ArchiveBot/i, /Uptimebot/i,
  /StatusCake/i, /Pingdom/i, /NewRelic/i, /Datadog/i
];

function isBot(userAgent) {
  if (!userAgent) return false;
  return BOT_PATTERNS.some(pattern => pattern.test(userAgent));
}

// Track event endpoint (client-side tracking)
app.post('/api/events', async (req, res) => {
  try {
    const { visitor_id, event_type, page_path, referrer, metadata } = req.body;
    const user_agent = req.headers['user-agent'];
    const ip_address = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;

    // Filter out bots
    if (isBot(user_agent)) {
      return res.json({ tracked: false, reason: 'bot' });
    }

    // Validate required fields
    if (!visitor_id || !event_type) {
      return res.status(400).json({ error: 'visitor_id and event_type are required' });
    }

    // Insert event
    await pool.query(
      `INSERT INTO events (visitor_id, event_type, page_path, referrer, user_agent, ip_address, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [visitor_id, event_type, page_path, referrer, user_agent, ip_address, JSON.stringify(metadata || {})]
    );

    res.json({ tracked: true });
  } catch (err) {
    console.error('Event tracking error:', err);
    // Don't return 500 - tracking failures should never break user experience
    res.json({ tracked: false, reason: 'error' });
  }
});

// Admin events dashboard API
app.get('/api/admin/events', requireAdmin, async (req, res) => {
  try {
    const timeFilter = req.query.time || '24h'; // 24h, 7d, 30d

    let timeInterval;
    switch (timeFilter) {
      case '7d':
        timeInterval = '7 days';
        break;
      case '30d':
        timeInterval = '30 days';
        break;
      default:
        timeInterval = '24 hours';
    }

    // Total events
    const totalEventsResult = await pool.query(
      `SELECT COUNT(*) as count FROM events WHERE created_at >= NOW() - INTERVAL '${timeInterval}'`
    );
    const totalEvents = parseInt(totalEventsResult.rows[0].count);

    // Unique visitors
    const uniqueVisitorsResult = await pool.query(
      `SELECT COUNT(DISTINCT visitor_id) as count FROM events WHERE created_at >= NOW() - INTERVAL '${timeInterval}'`
    );
    const uniqueVisitors = parseInt(uniqueVisitorsResult.rows[0].count);

    // Event breakdown by type
    const eventBreakdownResult = await pool.query(
      `SELECT event_type, COUNT(*) as count
       FROM events
       WHERE created_at >= NOW() - INTERVAL '${timeInterval}'
       GROUP BY event_type
       ORDER BY count DESC`
    );
    const eventBreakdown = eventBreakdownResult.rows.map(row => ({
      event_type: row.event_type,
      count: parseInt(row.count)
    }));

    // Recent events (last 50)
    const recentEventsResult = await pool.query(
      `SELECT event_type, page_path, metadata, created_at
       FROM events
       WHERE created_at >= NOW() - INTERVAL '${timeInterval}'
       ORDER BY created_at DESC
       LIMIT 50`
    );
    const recentEvents = recentEventsResult.rows;

    res.json({
      totalEvents,
      uniqueVisitors,
      eventBreakdown,
      recentEvents,
      timeFilter
    });
  } catch (err) {
    console.error('Admin events error:', err);
    res.status(500).json({ error: 'Failed to load events data' });
  }
});

// ============================================================
// OG IMAGE GENERATION
// ============================================================
app.get('/og/quiz/:slug.png', async (req, res) => {
  try {
    const { slug } = req.params;

    // Fetch quiz info
    const quizResult = await pool.query(
      'SELECT topic FROM quizzes WHERE slug = $1',
      [slug]
    );

    if (quizResult.rows.length === 0) {
      return res.status(404).send('Quiz not found');
    }

    const topic = quizResult.rows[0].topic;

    // Get play count
    const countResult = await pool.query(
      'SELECT COUNT(*) as c FROM quiz_attempts WHERE quiz_id = (SELECT id FROM quizzes WHERE slug = $1)',
      [slug]
    );
    const playCount = parseInt(countResult.rows[0].c);

    // Get top score
    const topScoreResult = await pool.query(
      `SELECT score, total_questions, player_name
       FROM quiz_attempts
       WHERE quiz_id = (SELECT id FROM quizzes WHERE slug = $1)
       ORDER BY score DESC, time_taken_seconds ASC NULLS LAST
       LIMIT 1`,
      [slug]
    );

    let topScoreText = '';
    if (topScoreResult.rows.length > 0) {
      const top = topScoreResult.rows[0];
      const percentage = Math.round((top.score / top.total_questions) * 100);
      topScoreText = `Top Score: ${percentage}%`;
    }

    // Generate SVG
    const svg = `<svg width="1200" height="630" xmlns="http://www.w3.org/2000/svg">
  <!-- Background -->
  <rect width="1200" height="630" fill="#0a0a0a"/>

  <!-- Accent gradient -->
  <defs>
    <linearGradient id="accentGrad" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#c8ff00;stop-opacity:0.15" />
      <stop offset="100%" style="stop-color:#c8ff00;stop-opacity:0.03" />
    </linearGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#accentGrad)"/>

  <!-- Border -->
  <rect x="60" y="60" width="1080" height="510" fill="none" stroke="#222" stroke-width="2" rx="20"/>

  <!-- Brand -->
  <text x="100" y="130" font-family="Arial, sans-serif" font-size="32" font-weight="bold" fill="#f0f0f0">
    stumped<tspan fill="#c8ff00">.</tspan>
  </text>

  <!-- Topic -->
  <text x="100" y="220" font-family="Arial, sans-serif" font-size="20" font-weight="500" fill="#c8ff00" text-transform="uppercase" letter-spacing="2">
    TRIVIA QUIZ
  </text>
  <text x="100" y="300" font-family="Arial, sans-serif" font-size="56" font-weight="bold" fill="#f0f0f0" text-anchor="start">
    ${escapeXml(topic.length > 35 ? topic.substring(0, 35) + '...' : topic)}
  </text>

  <!-- Stats -->
  <text x="100" y="400" font-family="Arial, sans-serif" font-size="24" fill="#888">
    ${playCount > 0 ? `${playCount} ${playCount === 1 ? 'player' : 'players'} • ` : ''}10 questions • 30s each
  </text>
  ${topScoreText ? `<text x="100" y="450" font-family="Arial, sans-serif" font-size="22" fill="#c8ff00">${escapeXml(topScoreText)}</text>` : ''}

  <!-- CTA -->
  <rect x="100" y="480" width="200" height="50" fill="#c8ff00" rx="8"/>
  <text x="200" y="512" font-family="Arial, sans-serif" font-size="20" font-weight="bold" fill="#0a0a0a" text-anchor="middle">
    Play Now
  </text>
</svg>`;

    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=3600'); // Cache for 1 hour
    res.send(svg);
  } catch (err) {
    console.error('OG image generation error:', err);
    res.status(500).send('Failed to generate image');
  }
});

// Helper to escape XML special characters
function escapeXml(unsafe) {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ============================================================
// PAGES: Quiz page with OG meta tags
// ============================================================
app.get('/quiz/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // Fetch quiz info for OG tags
    const quizResult = await pool.query(
      'SELECT topic FROM quizzes WHERE slug = $1',
      [slug]
    );

    const topic = quizResult.rows.length > 0 ? quizResult.rows[0].topic : 'Trivia Quiz';
    const countResult = quizResult.rows.length > 0
      ? await pool.query('SELECT COUNT(*) as c FROM quiz_attempts WHERE quiz_id = (SELECT id FROM quizzes WHERE slug = $1)', [slug])
      : { rows: [{ c: 0 }] };
    const playerCount = parseInt(countResult.rows[0].c);

    const appUrl = process.env.APP_URL || `https://stumped.polsia.app`;

    res.type('html').send(getQuizPageHTML(slug, topic, playerCount, appUrl));
  } catch (err) {
    console.error('Quiz page error:', err);
    res.type('html').send(getQuizPageHTML(req.params.slug, 'Trivia Quiz', 0, 'https://stumped.polsia.app'));
  }
});

// ============================================================
// User profile page (with dynamic OG tags)
// ============================================================
app.get('/u/:displayName', async (req, res) => {
  try {
    const { displayName } = req.params;

    // Fetch user data for OG tags
    const userResult = await pool.query(
      `SELECT id, display_name, created_at, pro, pro_since, pro_expires
       FROM users WHERE LOWER(display_name) = $1`,
      [displayName.toLowerCase()]
    );

    let ogTitle = 'Profile | Stumped';
    let ogDesc = 'View trivia quiz profile on Stumped.';

    if (userResult.rows.length > 0) {
      const user = userResult.rows[0];

      // Get stats
      const statsResult = await pool.query(
        `SELECT
          COUNT(DISTINCT q.id) as quizzes_created,
          COUNT(DISTINCT qa.id) as quizzes_taken
         FROM users u
         LEFT JOIN quizzes q ON q.created_by_user_id = u.id
         LEFT JOIN quiz_attempts qa ON qa.user_id = u.id
         WHERE u.id = $1`,
        [user.id]
      );

      const stats = statsResult.rows[0];
      const quizzesCreated = parseInt(stats.quizzes_created);
      const quizzesTaken = parseInt(stats.quizzes_taken);

      ogTitle = `${user.display_name} on Stumped`;
      ogDesc = `${quizzesCreated} ${quizzesCreated === 1 ? 'quiz' : 'quizzes'} created · ${quizzesTaken} ${quizzesTaken === 1 ? 'quiz' : 'quizzes'} played`;
    }

    const appUrl = process.env.APP_URL || 'https://stumped.polsia.app';

    // Read profile.html and inject OG tags
    const htmlPath = path.join(__dirname, 'public', 'profile.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    // Inject OG tags after the title tag
    const ogTags = `
  <meta name="description" content="${ogDesc}">

  <!-- Open Graph -->
  <meta property="og:type" content="profile">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:url" content="${appUrl}/u/${encodeURIComponent(displayName)}">
  <meta property="og:site_name" content="Stumped">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
`;

    // Replace the title tag with title + OG tags
    html = html.replace(
      /<title id="page-title">Profile \| Stumped<\/title>/,
      `<title id="page-title">${ogTitle}</title>${ogTags}`
    );

    res.type('html').send(html);
  } catch (err) {
    console.error('Profile page error:', err);
    // Fallback to static file
    res.sendFile(path.join(__dirname, 'public', 'profile.html'));
  }
});

// Dashboard page
app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Pricing page
app.get('/pricing', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pricing.html'));
});

// Explore page
app.get('/explore', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'explore.html'));
});

// Create quiz page
app.get('/create', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'create.html'));
});

// Admin pages
app.get('/admin/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin-login.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ============================================================
// Landing page with analytics beacon
// ============================================================
app.get('/', (req, res) => {
  const slug = process.env.POLSIA_ANALYTICS_SLUG || '';
  const htmlPath = path.join(__dirname, 'public', 'index.html');

  if (fs.existsSync(htmlPath)) {
    let html = fs.readFileSync(htmlPath, 'utf8');
    html = html.replace('__POLSIA_SLUG__', slug);
    res.type('html').send(html);
  } else {
    res.json({ message: 'Hello from Stumped!' });
  }
});

// ============================================================
// HTML Templates
// ============================================================
function getQuizPageHTML(slug, topic, playerCount, appUrl) {
  const ogTitle = playerCount > 0
    ? `Can you beat ${playerCount} ${playerCount === 1 ? 'player' : 'players'}? ${topic} Trivia`
    : `${topic} Trivia - Can You Get Them All Right?`;
  const ogDesc = `10 questions. 30 seconds each. ${playerCount > 0 ? playerCount + ' people have tried. ' : ''}Think you know your stuff?`;
  const ogImage = `${appUrl}/og/quiz/${slug}.png`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${topic} | Stumped</title>
  <meta name="description" content="${ogDesc}">

  <!-- Open Graph -->
  <meta property="og:type" content="website">
  <meta property="og:title" content="${ogTitle}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:url" content="${appUrl}/quiz/${slug}">
  <meta property="og:site_name" content="Stumped">
  <meta property="og:image" content="${ogImage}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:type" content="image/svg+xml">

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">
  <meta name="twitter:image" content="${ogImage}">

  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=DM+Sans:wght@400;500&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    :root {
      --bg: #0a0a0a;
      --surface: #141414;
      --surface-2: #1a1a1a;
      --border: #222;
      --text: #f0f0f0;
      --text-muted: #888;
      --accent: #c8ff00;
      --accent-dim: rgba(200, 255, 0, 0.08);
      --correct: #22c55e;
      --correct-dim: rgba(34, 197, 94, 0.1);
      --wrong: #ef4444;
      --wrong-dim: rgba(239, 68, 68, 0.1);
    }
    body {
      font-family: 'DM Sans', -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      min-height: 100vh;
    }
    .container { max-width: 680px; margin: 0 auto; padding: 0 20px; }

    /* NAV */
    .quiz-nav {
      padding: 20px 0;
      border-bottom: 1px solid var(--border);
    }
    .quiz-nav .container {
      display: flex; justify-content: space-between; align-items: center;
    }
    .logo {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 700; font-size: 20px;
      letter-spacing: -0.5px;
      color: var(--text);
      text-decoration: none;
    }
    .logo span { color: var(--accent); }

    /* SCREENS */
    .screen { display: none; }
    .screen.active { display: block; }

    /* JOIN SCREEN */
    .join-screen { padding: 60px 0; text-align: center; }
    .join-topic {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 14px; font-weight: 500;
      color: var(--accent);
      background: var(--accent-dim);
      padding: 6px 16px; border-radius: 100px;
      border: 1px solid rgba(200, 255, 0, 0.15);
      display: inline-block; margin-bottom: 24px;
      text-transform: uppercase; letter-spacing: 0.5px;
    }
    .join-screen h1 {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 36px; font-weight: 700;
      letter-spacing: -1px; margin-bottom: 12px;
    }
    .join-screen h1 em { font-style: normal; color: var(--accent); }
    .join-meta {
      color: var(--text-muted); font-size: 15px;
      margin-bottom: 40px;
    }
    .join-form {
      max-width: 360px; margin: 0 auto;
    }
    .join-input {
      width: 100%; padding: 16px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text); font-size: 16px;
      font-family: 'DM Sans', sans-serif;
      outline: none; margin-bottom: 12px;
      transition: border-color 0.2s;
    }
    .join-input:focus { border-color: var(--accent); }
    .join-input::placeholder { color: var(--text-muted); }
    .btn-play {
      width: 100%; padding: 16px;
      background: var(--accent);
      color: #0a0a0a;
      border: none; border-radius: 12px;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 16px; font-weight: 600;
      cursor: pointer; transition: opacity 0.2s;
      letter-spacing: -0.3px;
    }
    .btn-play:hover { opacity: 0.9; }
    .btn-play:disabled { opacity: 0.5; cursor: not-allowed; }

    /* QUIZ SCREEN */
    .quiz-screen { padding: 40px 0; }
    .quiz-header {
      display: flex; justify-content: space-between; align-items: center;
      margin-bottom: 8px;
    }
    .quiz-topic-label {
      font-size: 14px; color: var(--text-muted);
    }
    .quiz-timer {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 18px; font-weight: 600;
      color: var(--accent);
      background: var(--accent-dim);
      padding: 6px 16px; border-radius: 10px;
      min-width: 60px; text-align: center;
    }
    .quiz-timer.urgent { color: var(--wrong); background: var(--wrong-dim); }
    .quiz-progress {
      height: 4px;
      background: var(--border);
      border-radius: 2px;
      margin-bottom: 40px;
      overflow: hidden;
    }
    .quiz-progress-fill {
      height: 100%;
      background: var(--accent);
      border-radius: 2px;
      transition: width 0.3s ease;
    }
    .question-counter {
      font-size: 13px; color: var(--text-muted);
      margin-bottom: 16px;
    }
    .question-text {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 24px; font-weight: 600;
      line-height: 1.35; letter-spacing: -0.5px;
      margin-bottom: 32px;
    }
    .options-list { display: flex; flex-direction: column; gap: 12px; }
    .option-btn {
      display: flex; align-items: center; gap: 14px;
      padding: 18px 20px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      color: var(--text); font-size: 16px;
      cursor: pointer; transition: all 0.15s;
      text-align: left; width: 100%;
      font-family: 'DM Sans', sans-serif;
    }
    .option-btn:hover { border-color: rgba(200, 255, 0, 0.3); background: var(--surface-2); }
    .option-btn.selected { border-color: var(--accent); background: var(--accent-dim); }
    .option-letter {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 600; font-size: 14px;
      width: 32px; height: 32px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 8px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      flex-shrink: 0;
      transition: all 0.15s;
    }
    .option-btn.selected .option-letter {
      background: var(--accent); color: #0a0a0a; border-color: var(--accent);
    }

    /* RESULTS SCREEN */
    .results-screen { padding: 40px 0 80px; }
    .results-hero { text-align: center; margin-bottom: 48px; }
    .results-score {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 72px; font-weight: 700;
      color: var(--accent); letter-spacing: -3px;
      line-height: 1;
    }
    .results-label {
      font-size: 16px; color: var(--text-muted);
      margin-top: 8px;
    }
    .results-msg {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 24px; font-weight: 600;
      margin-top: 20px; letter-spacing: -0.5px;
    }

    /* Share section */
    .share-section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 24px;
      margin-bottom: 40px;
      text-align: center;
    }
    .score-badge {
      display: inline-block;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 28px; font-weight: 700;
      color: var(--accent);
      background: var(--accent-dim);
      padding: 12px 28px;
      border-radius: 100px;
      border: 1px solid rgba(200, 255, 0, 0.15);
      margin-bottom: 16px;
      letter-spacing: -0.5px;
    }
    .share-section p {
      font-size: 15px; color: var(--text-muted);
      margin-bottom: 16px;
    }
    .share-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .btn-share {
      padding: 12px 20px;
      border-radius: 10px;
      font-family: 'Space Grotesk', sans-serif;
      font-size: 14px; font-weight: 600;
      cursor: pointer; transition: opacity 0.2s;
      border: none;
      letter-spacing: -0.2px;
    }
    .btn-share:hover { opacity: 0.85; }
    .btn-share.primary { background: var(--accent); color: #0a0a0a; }
    .btn-share.secondary {
      background: var(--surface-2); color: var(--text);
      border: 1px solid var(--border);
    }

    /* Leaderboard */
    .leaderboard-section { margin-bottom: 40px; }
    .leaderboard-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 20px; font-weight: 600;
      margin-bottom: 16px; letter-spacing: -0.3px;
    }
    .leaderboard-table {
      width: 100%;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
    }
    .lb-row {
      display: grid;
      grid-template-columns: 48px 1fr 80px 80px;
      align-items: center;
      padding: 14px 20px;
      border-bottom: 1px solid var(--border);
      font-size: 14px;
    }
    .lb-row:last-child { border-bottom: none; }
    .lb-row.header {
      font-size: 12px; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: 0.5px;
      padding: 12px 20px;
      background: var(--surface-2);
    }
    .lb-row.highlight { background: var(--accent-dim); }
    .lb-rank {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 600;
    }
    .lb-name { font-weight: 500; }
    .lb-score {
      font-family: 'Space Grotesk', sans-serif;
      font-weight: 600; color: var(--accent);
      text-align: center;
    }
    .lb-time {
      color: var(--text-muted);
      text-align: center;
    }

    /* Review */
    .review-section { }
    .review-title {
      font-family: 'Space Grotesk', sans-serif;
      font-size: 20px; font-weight: 600;
      margin-bottom: 16px; letter-spacing: -0.3px;
    }
    .review-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px;
      margin-bottom: 12px;
    }
    .review-card.correct { border-left: 3px solid var(--correct); }
    .review-card.wrong { border-left: 3px solid var(--wrong); }
    .review-q {
      font-weight: 500; margin-bottom: 12px;
      line-height: 1.4;
    }
    .review-answer {
      font-size: 14px; padding: 8px 12px;
      border-radius: 8px; margin-bottom: 4px;
    }
    .review-answer.correct-answer {
      background: var(--correct-dim);
      color: var(--correct);
    }
    .review-answer.wrong-answer {
      background: var(--wrong-dim);
      color: var(--wrong);
    }

    /* Loading */
    .loading { text-align: center; padding: 80px 0; }
    .spinner {
      width: 36px; height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
      margin: 0 auto 16px;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .loading-text { color: var(--text-muted); font-size: 15px; }

    /* Error */
    .error-msg {
      background: var(--wrong-dim);
      color: var(--wrong);
      padding: 14px 20px;
      border-radius: 10px;
      font-size: 14px;
      margin-bottom: 16px;
      display: none;
    }
    .error-msg.show { display: block; }

    /* MOBILE — Tablet (768px) */
    @media (max-width: 768px) {
      .container { padding: 0 16px; }
      .join-screen { padding: 48px 0; }
      .join-screen h1 { font-size: 30px; }
      .quiz-screen { padding: 28px 0; }
      .question-text { font-size: 22px; margin-bottom: 28px; }
      .results-screen { padding: 32px 0 64px; }
      .results-hero { margin-bottom: 36px; }
      .share-section { padding: 20px; margin-bottom: 32px; }
      .leaderboard-section { margin-bottom: 32px; }
    }

    /* MOBILE — Phone (480px) */
    @media (max-width: 480px) {
      .container { padding: 0 14px; }
      .quiz-nav { padding: 14px 0; }
      .logo { font-size: 18px; }

      /* Join screen */
      .join-screen { padding: 36px 0; }
      .join-topic { font-size: 12px; padding: 5px 14px; margin-bottom: 20px; }
      .join-screen h1 { font-size: 26px; letter-spacing: -0.5px; margin-bottom: 10px; }
      .join-meta { font-size: 14px; margin-bottom: 28px; }
      .join-form { max-width: 100%; }
      .join-input {
        font-size: 16px;
        padding: 16px 18px;
        border-radius: 12px;
        margin-bottom: 12px;
      }
      .btn-play {
        min-height: 52px;
        font-size: 16px;
        padding: 16px;
        border-radius: 12px;
      }

      /* Quiz screen */
      .quiz-screen { padding: 20px 0; }
      .quiz-header { margin-bottom: 6px; }
      .quiz-topic-label { font-size: 13px; }
      .quiz-timer {
        font-size: 20px;
        padding: 8px 18px;
        border-radius: 10px;
        min-width: 64px;
      }
      .quiz-progress { margin-bottom: 24px; height: 5px; }
      .question-counter { font-size: 13px; margin-bottom: 12px; }
      .question-text {
        font-size: 20px;
        line-height: 1.4;
        margin-bottom: 24px;
      }
      .options-list { gap: 10px; }
      .option-btn {
        padding: 16px 16px;
        border-radius: 14px;
        font-size: 15px;
        gap: 12px;
        min-height: 56px;
        -webkit-tap-highlight-color: transparent;
      }
      .option-btn:active {
        transform: scale(0.98);
        background: var(--surface-2);
      }
      .option-letter {
        width: 36px;
        height: 36px;
        font-size: 15px;
        border-radius: 10px;
      }

      /* Results screen */
      .results-screen { padding: 28px 0 48px; }
      .results-hero { margin-bottom: 28px; }
      .results-score { font-size: 52px; letter-spacing: -2px; }
      .results-label { font-size: 14px; }
      .results-msg { font-size: 20px; margin-top: 16px; }

      /* Share section */
      .share-section {
        padding: 20px 16px;
        border-radius: 14px;
        margin-bottom: 28px;
      }
      .score-badge {
        font-size: 24px;
        padding: 10px 24px;
        margin-bottom: 14px;
      }
      .share-section p { font-size: 14px; margin-bottom: 14px; }
      .share-actions {
        flex-direction: column;
        gap: 10px;
      }
      .btn-share {
        width: 100%;
        padding: 14px 20px;
        min-height: 48px;
        font-size: 15px;
        border-radius: 12px;
        -webkit-tap-highlight-color: transparent;
      }
      .btn-share:active { transform: scale(0.98); }

      /* Leaderboard */
      .leaderboard-title { font-size: 18px; margin-bottom: 12px; }
      .leaderboard-table { border-radius: 14px; }
      .lb-row {
        grid-template-columns: 36px 1fr 56px 56px;
        padding: 12px 14px;
        font-size: 13px;
        min-height: 48px;
        align-items: center;
      }
      .lb-row.header {
        font-size: 11px;
        padding: 10px 14px;
        min-height: auto;
      }
      .lb-rank { font-size: 14px; }
      .lb-name { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .lb-score { font-size: 13px; }
      .lb-time { font-size: 12px; }

      /* Review */
      .review-title { font-size: 18px; margin-bottom: 12px; }
      .review-card {
        padding: 16px;
        border-radius: 14px;
        margin-bottom: 10px;
      }
      .review-q { font-size: 14px; margin-bottom: 10px; }
      .review-answer { font-size: 13px; padding: 8px 12px; border-radius: 8px; }

      /* Loading */
      .loading { padding: 60px 0; }
    }

    /* Extra small phones (375px and below like iPhone SE) */
    @media (max-width: 375px) {
      .container { padding: 0 12px; }
      .join-screen h1 { font-size: 24px; }
      .question-text { font-size: 18px; }
      .results-score { font-size: 44px; }
      .option-btn { padding: 14px 14px; font-size: 14px; min-height: 52px; }
      .option-letter { width: 32px; height: 32px; font-size: 14px; }
      .lb-row { grid-template-columns: 32px 1fr 48px 48px; padding: 10px 12px; font-size: 12px; }
      .lb-row.header { font-size: 10px; }
    }
  </style>
</head>
<body>
  <nav class="quiz-nav">
    <div class="container">
      <a href="/" class="logo">stumped<span>.</span></a>
      <div id="nav-auth"></div>
    </div>
  </nav>

  <!-- LOADING -->
  <div id="loading-screen" class="screen active">
    <div class="container loading">
      <div class="spinner"></div>
      <div class="loading-text">Loading quiz...</div>
    </div>
  </div>

  <!-- JOIN SCREEN -->
  <div id="join-screen" class="screen">
    <div class="container join-screen">
      <div class="join-topic" id="join-topic"></div>
      <h1>Think you know<br><em id="join-topic-name"></em>?</h1>
      <p class="join-meta" id="join-meta">10 questions &middot; 30 seconds each</p>
      <div class="join-form">
        <div class="error-msg" id="join-error"></div>
        <input type="text" class="join-input" id="player-name" placeholder="Your name" maxlength="50" autocomplete="off">
        <button class="btn-play" id="btn-start">Let's go</button>
      </div>
    </div>
  </div>

  <!-- QUIZ SCREEN -->
  <div id="quiz-screen" class="screen">
    <div class="container quiz-screen">
      <div class="quiz-header">
        <span class="quiz-topic-label" id="quiz-topic-label"></span>
        <div class="quiz-timer" id="quiz-timer">30</div>
      </div>
      <div class="quiz-progress"><div class="quiz-progress-fill" id="quiz-progress"></div></div>
      <div class="question-counter" id="question-counter"></div>
      <div class="question-text" id="question-text"></div>
      <div class="options-list" id="options-list"></div>
    </div>
  </div>

  <!-- RESULTS SCREEN -->
  <div id="results-screen" class="screen">
    <div class="container results-screen">
      <div class="results-hero">
        <div class="results-score" id="results-score"></div>
        <div class="results-label" id="results-label"></div>
        <div class="results-msg" id="results-msg"></div>
      </div>
      <div class="share-section">
        <div class="score-badge" id="score-badge"></div>
        <p>Challenge your friends — can they beat your score?</p>
        <div class="share-actions">
          <button class="btn-share primary" id="btn-share">
            <span id="share-btn-text">Challenge a Friend</span>
          </button>
          <button class="btn-share secondary" id="btn-play-again">Play Again</button>
          <button class="btn-share secondary" id="btn-try-another">Try Another Quiz</button>
        </div>
      </div>
      <div class="leaderboard-section">
        <div class="leaderboard-title">Leaderboard</div>
        <div class="leaderboard-table" id="leaderboard"></div>
      </div>
      <div class="review-section">
        <div class="review-title">Review Answers</div>
        <div id="review-list"></div>
      </div>
    </div>
  </div>

  <!-- NOT FOUND -->
  <div id="notfound-screen" class="screen">
    <div class="container" style="padding:80px 0;text-align:center;">
      <h1 style="font-family:'Space Grotesk',sans-serif;font-size:36px;margin-bottom:16px;">Quiz not found</h1>
      <p style="color:var(--text-muted);margin-bottom:32px;">This quiz doesn't exist or has been removed.</p>
      <a href="/" class="btn-play" style="display:inline-block;padding:14px 32px;text-decoration:none;border-radius:12px;">Create a Quiz</a>
    </div>
  </div>

  <script>
  // Auth state
  let currentUser = null;
  (function() {
    const navAuth = document.getElementById('nav-auth');

    async function loadAuthState() {
      try {
        const res = await fetch('/api/auth/me');
        if (res.ok) {
          const data = await res.json();
          currentUser = data.user;
          navAuth.innerHTML = '<a href="/dashboard" style="font-size:13px;color:var(--text);text-decoration:none;font-weight:500;">' + escHtml(data.user.displayName) + '</a>';

          // Auto-fill name for logged-in users
          const nameInput = document.getElementById('player-name');
          if (nameInput) {
            nameInput.value = data.user.displayName;
            nameInput.setAttribute('readonly', 'true');
            nameInput.style.opacity = '0.7';
          }
        } else {
          navAuth.innerHTML = '<a href="/login.html" style="font-size:13px;color:var(--text-muted);text-decoration:none;">Log In</a>';
        }
      } catch (err) {
        navAuth.innerHTML = '<a href="/login.html" style="font-size:13px;color:var(--text-muted);text-decoration:none;">Log In</a>';
      }
    }

    function escHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    loadAuthState();
  })();

  // Quiz logic
  (function() {
    const slug = '${slug}';
    let quiz = null;
    let currentQ = 0;
    let answers = {};
    let playerName = '';
    let timer = null;
    let timeLeft = 30;
    let totalTimeTaken = 0;
    let quizStartTime = null;

    const screens = {
      loading: document.getElementById('loading-screen'),
      join: document.getElementById('join-screen'),
      quiz: document.getElementById('quiz-screen'),
      results: document.getElementById('results-screen'),
      notfound: document.getElementById('notfound-screen')
    };

    function showScreen(name) {
      Object.values(screens).forEach(s => s.classList.remove('active'));
      screens[name].classList.add('active');
    }

    // Load quiz
    async function loadQuiz() {
      try {
        const res = await fetch('/api/quizzes/' + slug);
        if (!res.ok) { showScreen('notfound'); return; }
        quiz = await res.json();

        document.getElementById('join-topic').textContent = quiz.topic;
        document.getElementById('join-topic-name').textContent = quiz.topic;
        const meta = '10 questions \\u00b7 30 seconds each';
        if (quiz.playerCount > 0) {
          document.getElementById('join-meta').textContent = quiz.playerCount + ' player' + (quiz.playerCount !== 1 ? 's' : '') + ' \\u00b7 ' + meta;
        } else {
          document.getElementById('join-meta').textContent = meta;
        }
        document.getElementById('quiz-topic-label').textContent = quiz.topic;
        document.getElementById('nav-info').textContent = quiz.topic;

        showScreen('join');
      } catch (e) {
        showScreen('notfound');
      }
    }

    // Start quiz
    document.getElementById('btn-start').addEventListener('click', () => {
      playerName = document.getElementById('player-name').value.trim();
      if (!playerName) {
        document.getElementById('join-error').textContent = 'Enter your name to play';
        document.getElementById('join-error').classList.add('show');
        return;
      }
      currentQ = 0;
      answers = {};
      quizStartTime = Date.now();
      showScreen('quiz');
      showQuestion();
    });

    document.getElementById('player-name').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('btn-start').click();
    });

    // Show question
    function showQuestion() {
      if (currentQ >= quiz.questions.length) { submitQuiz(); return; }

      const q = quiz.questions[currentQ];
      document.getElementById('question-counter').textContent = 'Question ' + (currentQ + 1) + ' of ' + quiz.questions.length;
      document.getElementById('question-text').textContent = q.question;
      document.getElementById('quiz-progress').style.width = ((currentQ / quiz.questions.length) * 100) + '%';

      const optList = document.getElementById('options-list');
      optList.innerHTML = '';

      ['A', 'B', 'C', 'D'].forEach(letter => {
        const btn = document.createElement('button');
        btn.className = 'option-btn';
        btn.innerHTML = '<span class="option-letter">' + letter + '</span><span>' + q.options[letter] + '</span>';
        btn.addEventListener('click', () => selectAnswer(letter));
        optList.appendChild(btn);
      });

      // Timer
      startTimer();
    }

    function startTimer() {
      clearInterval(timer);
      timeLeft = 30;
      updateTimerDisplay();
      timer = setInterval(() => {
        timeLeft--;
        updateTimerDisplay();
        if (timeLeft <= 0) {
          clearInterval(timer);
          // Auto-advance (no answer)
          currentQ++;
          showQuestion();
        }
      }, 1000);
    }

    function updateTimerDisplay() {
      const el = document.getElementById('quiz-timer');
      el.textContent = timeLeft;
      el.className = 'quiz-timer' + (timeLeft <= 10 ? ' urgent' : '');
    }

    function selectAnswer(letter) {
      clearInterval(timer);
      answers[quiz.questions[currentQ].number] = letter;

      // Highlight selected
      const btns = document.querySelectorAll('.option-btn');
      btns.forEach(b => b.classList.remove('selected'));
      btns[['A','B','C','D'].indexOf(letter)].classList.add('selected');

      // Brief pause then next
      setTimeout(() => {
        currentQ++;
        showQuestion();
      }, 300);
    }

    // Submit
    async function submitQuiz() {
      clearInterval(timer);
      totalTimeTaken = Math.round((Date.now() - quizStartTime) / 1000);

      showScreen('loading');
      document.querySelector('.loading-text').textContent = 'Calculating your score...';

      try {
        const res = await fetch('/api/quizzes/' + slug + '/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ playerName, answers, timeTaken: totalTimeTaken })
        });

        const data = await res.json();
        showResults(data);
      } catch (e) {
        showScreen('join');
        document.getElementById('join-error').textContent = 'Failed to submit. Please try again.';
        document.getElementById('join-error').classList.add('show');
      }
    }

    // Results
    async function showResults(data) {
      document.getElementById('results-score').textContent = data.score + '/' + data.total;
      document.getElementById('results-label').textContent = data.percentage + '% correct \\u00b7 ' + formatTime(totalTimeTaken);

      // Score badge
      const emoji = data.percentage >= 90 ? '⭐' : data.percentage >= 70 ? '🔥' : data.percentage >= 50 ? '👍' : '🧠';
      document.getElementById('score-badge').textContent = data.score + '/' + data.total + ' ' + emoji;

      const msgs = [
        { min: 0, msg: 'Room for improvement...' },
        { min: 30, msg: 'Not bad, not bad.' },
        { min: 50, msg: 'Solid performance!' },
        { min: 70, msg: 'Impressive knowledge!' },
        { min: 90, msg: 'Absolutely crushed it!' },
        { min: 100, msg: 'Perfect score. Legend.' }
      ];
      const msg = msgs.filter(m => data.percentage >= m.min).pop();
      document.getElementById('results-msg').textContent = msg.msg;

      // Review
      const reviewList = document.getElementById('review-list');
      reviewList.innerHTML = '';
      data.results.forEach(r => {
        const card = document.createElement('div');
        card.className = 'review-card ' + (r.isCorrect ? 'correct' : 'wrong');

        let html = '<div class="review-q">' + r.number + '. ' + r.question + '</div>';
        if (!r.isCorrect && r.playerAnswer) {
          html += '<div class="review-answer wrong-answer">Your answer: ' + r.playerAnswer + ') ' + r.options[r.playerAnswer] + '</div>';
        }
        if (!r.isCorrect && !r.playerAnswer) {
          html += '<div class="review-answer wrong-answer">No answer (time ran out)</div>';
        }
        html += '<div class="review-answer correct-answer">Correct: ' + r.correctAnswer + ') ' + r.options[r.correctAnswer] + '</div>';
        card.innerHTML = html;
        reviewList.appendChild(card);
      });

      // Leaderboard
      await loadLeaderboard();

      showScreen('results');
    }

    async function loadLeaderboard() {
      try {
        const res = await fetch('/api/quizzes/' + slug + '/leaderboard');
        const data = await res.json();

        const lb = document.getElementById('leaderboard');
        let html = '<div class="lb-row header"><span>#</span><span>Player</span><span>Score</span><span>Time</span></div>';

        data.entries.forEach(e => {
          const isMe = e.playerName === playerName;
          html += '<div class="lb-row' + (isMe ? ' highlight' : '') + '">';
          html += '<span class="lb-rank">' + e.rank + '</span>';

          // Link to profile if user has account
          if (e.userDisplayName) {
            html += '<span class="lb-name"><a href="/u/' + encodeURIComponent(e.userDisplayName) + '" style="color:var(--text);text-decoration:none;">' + escHtml(e.playerName) + '</a>' + (isMe ? ' (you)' : '') + '</span>';
          } else {
            html += '<span class="lb-name">' + escHtml(e.playerName) + (isMe ? ' (you)' : '') + '</span>';
          }

          html += '<span class="lb-score">' + e.score + '/' + e.total + '</span>';
          html += '<span class="lb-time">' + (e.timeTaken ? formatTime(e.timeTaken) : '-') + '</span>';
          html += '</div>';
        });

        lb.innerHTML = html;
      } catch (e) {
        console.error('Leaderboard error:', e);
      }
    }

    // Share - Web Share API on mobile, copy-to-clipboard on desktop
    document.getElementById('btn-share').addEventListener('click', async () => {
      const url = window.location.origin + '/quiz/' + slug;
      const score = document.getElementById('results-score').textContent;
      const shareText = 'I scored ' + score + ' on ' + quiz.topic + ' trivia 🧠 Can you beat me? ' + url;

      // Try Web Share API first (mobile native sharing)
      if (navigator.share) {
        try {
          await navigator.share({
            title: quiz.topic + ' Quiz',
            text: shareText,
            url: url
          });
          return;
        } catch (err) {
          // User cancelled or error - fall through to clipboard
          if (err.name === 'AbortError') return; // User cancelled, don't show copied message
        }
      }

      // Fallback to copy-to-clipboard
      try {
        await navigator.clipboard.writeText(shareText);
        document.getElementById('share-btn-text').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('share-btn-text').textContent = 'Challenge a Friend'; }, 2000);
      } catch (err) {
        // Fallback for older browsers
        const ta = document.createElement('textarea');
        ta.value = shareText;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        document.getElementById('share-btn-text').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('share-btn-text').textContent = 'Challenge a Friend'; }, 2000);
      }
    });

    document.getElementById('btn-play-again').addEventListener('click', () => {
      currentQ = 0;
      answers = {};
      showScreen('join');
      document.getElementById('player-name').value = '';
      document.getElementById('join-error').classList.remove('show');
    });

    document.getElementById('btn-try-another').addEventListener('click', () => {
      window.location.href = '/explore';
    });

    // Utils
    function formatTime(s) {
      const m = Math.floor(s / 60);
      const sec = s % 60;
      return m > 0 ? m + 'm ' + sec + 's' : sec + 's';
    }
    function escHtml(str) {
      const div = document.createElement('div');
      div.textContent = str;
      return div.innerHTML;
    }

    // Init
    loadQuiz();
  })();
  </script>

  <!-- Polsia Analytics -->
  <script>
  (function() {
      var slug = 'stumped';
      if (!slug) return;
      var vid = localStorage.getItem('polsia_vid');
      if (!vid) {
          vid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
              var r = Math.random() * 16 | 0;
              return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
          });
          localStorage.setItem('polsia_vid', vid);
      }
      new Image().src = 'https://polsia.com/api/beacon/pixel?s=' + encodeURIComponent(slug) + '&v=' + encodeURIComponent(vid);
  })();
  </script>
</body>
</html>`;
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
