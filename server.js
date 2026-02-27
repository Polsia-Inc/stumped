const express = require('express');
const { Pool } = require('pg');
const OpenAI = require('openai');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

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

app.use(express.json());

// Health check endpoint (required for Render)
app.get('/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Serve static files from public folder
app.use(express.static(path.join(__dirname, 'public')));

// ============================================================
// HELPERS
// ============================================================

function generateSlug() {
  return crypto.randomBytes(4).toString('hex'); // 8 char hex slug
}

// ============================================================
// API: Generate a quiz
// ============================================================
app.post('/api/quizzes/generate', async (req, res) => {
  try {
    const { topic } = req.body;
    if (!topic || topic.trim().length < 2) {
      return res.status(400).json({ error: 'Topic must be at least 2 characters' });
    }

    const cleanTopic = topic.trim().substring(0, 200);

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
      max_tokens: 2048,
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
        'INSERT INTO quizzes (slug, topic) VALUES ($1, $2) RETURNING id, slug',
        [slug, cleanTopic]
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

      await client.query('COMMIT');

      res.json({
        slug,
        topic: cleanTopic,
        questionCount: questions.length,
        url: `/quiz/${slug}`
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
      return res.status(404).json({ error: 'Quiz not found' });
    }

    const quiz = quizResult.rows[0];

    const questionsResult = await pool.query(
      `SELECT question_number, question_text, option_a, option_b, option_c, option_d
       FROM questions WHERE quiz_id = $1 ORDER BY question_number`,
      [quiz.id]
    );

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

    // Save attempt
    await pool.query(
      `INSERT INTO quiz_attempts (quiz_id, player_name, score, total_questions, time_taken_seconds, answers)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [quizId, playerName.trim().substring(0, 100), score, correctResult.rows.length, timeTaken || null, JSON.stringify(answers)]
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
      `SELECT player_name, score, total_questions, time_taken_seconds, completed_at
       FROM quiz_attempts WHERE quiz_id = $1
       ORDER BY score DESC, time_taken_seconds ASC NULLS LAST
       LIMIT 50`,
      [quizId]
    );

    res.json({
      topic: quizResult.rows[0].topic,
      entries: leaderboard.rows.map((row, i) => ({
        rank: i + 1,
        playerName: row.player_name,
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
  const ogTitle = `${topic} - Think you know your stuff?`;
  const ogDesc = `${playerCount > 0 ? playerCount + ' people have tried this quiz. ' : ''}10 questions. 30 seconds each. Can you get them all right?`;

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

  <!-- Twitter Card -->
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${ogTitle}">
  <meta name="twitter:description" content="${ogDesc}">

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

    @media (max-width: 600px) {
      .question-text { font-size: 20px; }
      .results-score { font-size: 56px; }
      .lb-row { grid-template-columns: 40px 1fr 60px 60px; padding: 12px 14px; }
    }
  </style>
</head>
<body>
  <nav class="quiz-nav">
    <div class="container">
      <a href="/" class="logo">stumped<span>.</span></a>
      <div id="nav-info" style="font-size:13px;color:var(--text-muted);"></div>
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
        <p>Challenge your friends</p>
        <div class="share-actions">
          <button class="btn-share primary" id="btn-copy-link">Copy Link</button>
          <button class="btn-share secondary" id="btn-share-twitter">Share on X</button>
          <button class="btn-share secondary" id="btn-play-again">Play Again</button>
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
          html += '<span class="lb-name">' + escHtml(e.playerName) + (isMe ? ' (you)' : '') + '</span>';
          html += '<span class="lb-score">' + e.score + '/' + e.total + '</span>';
          html += '<span class="lb-time">' + (e.timeTaken ? formatTime(e.timeTaken) : '-') + '</span>';
          html += '</div>';
        });

        lb.innerHTML = html;
      } catch (e) {
        console.error('Leaderboard error:', e);
      }
    }

    // Share
    document.getElementById('btn-copy-link').addEventListener('click', () => {
      const url = window.location.origin + '/quiz/' + slug;
      navigator.clipboard.writeText(url).then(() => {
        document.getElementById('btn-copy-link').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('btn-copy-link').textContent = 'Copy Link'; }, 2000);
      }).catch(() => {
        // Fallback
        const ta = document.createElement('textarea');
        ta.value = url;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        document.getElementById('btn-copy-link').textContent = 'Copied!';
        setTimeout(() => { document.getElementById('btn-copy-link').textContent = 'Copy Link'; }, 2000);
      });
    });

    document.getElementById('btn-share-twitter').addEventListener('click', () => {
      const url = window.location.origin + '/quiz/' + slug;
      const text = 'I scored ' + document.getElementById('results-score').textContent + ' on this ' + quiz.topic + ' quiz. Think you can beat me?';
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(text) + '&url=' + encodeURIComponent(url), '_blank');
    });

    document.getElementById('btn-play-again').addEventListener('click', () => {
      currentQ = 0;
      answers = {};
      showScreen('join');
      document.getElementById('player-name').value = '';
      document.getElementById('join-error').classList.remove('show');
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
