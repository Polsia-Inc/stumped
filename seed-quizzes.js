const { Pool } = require('pg');
const OpenAI = require('openai');
const crypto = require('crypto');
const bcrypt = require('bcrypt');

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

function generateSlug() {
  return crypto.randomBytes(4).toString('hex'); // 8 char hex slug
}

// Popular topics to seed the database
const QUIZ_TOPICS = [
  // Pop Culture
  'Marvel Cinematic Universe',
  'Taylor Swift',
  'The Office',
  'Harry Potter',
  'Friends',
  'Game of Thrones',
  'Star Wars',
  'Breaking Bad',
  'Stranger Things',
  'The Beatles',

  // Sports
  'NFL',
  'NBA',
  'World Cup Soccer',
  'Olympics',
  'Tom Brady',
  'LeBron James',

  // Science
  'Space Exploration',
  'Human Body',
  'Animals',
  'Dinosaurs',
  'Climate Change',
  'Chemistry',

  // History
  'World War II',
  'Ancient Rome',
  'US Presidents',
  'American Revolution',
  'Ancient Egypt',

  // Geography
  'World Capitals',
  'Country Flags',
  'Famous Landmarks',
  'US States',

  // Food & Drink
  'Fast Food',
  'Cocktails',
  'World Cuisines',
  'Coffee',

  // Music
  '90s Hip Hop',
  'Grammy Winners',
  'Classic Rock',
  'Pop Music',

  // Internet/Memes
  'Viral Moments',
  'TikTok Trends',
  'Internet History'
];

async function createSystemUser() {
  try {
    // Check if Stumped user already exists
    const existingUser = await pool.query(
      'SELECT id FROM users WHERE LOWER(email) = $1',
      ['stumped@polsia.app']
    );

    if (existingUser.rows.length > 0) {
      console.log('✓ Stumped system user already exists');
      return existingUser.rows[0].id;
    }

    // Create Stumped system user
    const passwordHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3)
       RETURNING id`,
      ['stumped@polsia.app', passwordHash, 'Stumped']
    );

    console.log('✓ Created Stumped system user');
    return result.rows[0].id;
  } catch (err) {
    console.error('Failed to create system user:', err);
    throw err;
  }
}

async function generateQuiz(topic, userId) {
  try {
    console.log(`  Generating quiz: "${topic}"...`);

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
          content: `Generate a 10-question trivia quiz about: ${topic}`
        }
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      temperature: 0.8
    });

    const aiResponse = JSON.parse(completion.choices[0].message.content);

    if (!aiResponse.questions || aiResponse.questions.length < 10) {
      console.error('  ✗ AI did not generate enough questions');
      return false;
    }

    const questions = aiResponse.questions.slice(0, 10);

    // Save to database
    const slug = generateSlug();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const quizResult = await client.query(
        'INSERT INTO quizzes (slug, topic, created_by_user_id) VALUES ($1, $2, $3) RETURNING id',
        [slug, topic, userId]
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
      console.log(`  ✓ Created quiz: "${topic}" (${slug})`);
      return true;
    } catch (dbErr) {
      await client.query('ROLLBACK');
      throw dbErr;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`  ✗ Failed to generate quiz "${topic}":`, err.message);
    return false;
  }
}

async function seedQuizzes() {
  console.log('Starting quiz seeding process...\n');

  try {
    // Create system user
    console.log('Step 1: Creating system user');
    const userId = await createSystemUser();
    console.log();

    // Generate quizzes
    console.log('Step 2: Generating quizzes');
    let successCount = 0;
    let failCount = 0;

    for (const topic of QUIZ_TOPICS) {
      const success = await generateQuiz(topic, userId);
      if (success) {
        successCount++;
      } else {
        failCount++;
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    console.log();
    console.log('='.repeat(50));
    console.log(`✓ Seeding complete!`);
    console.log(`  Success: ${successCount} quizzes`);
    console.log(`  Failed: ${failCount} quizzes`);
    console.log('='.repeat(50));

    process.exit(0);
  } catch (err) {
    console.error('Fatal error during seeding:', err);
    process.exit(1);
  }
}

// Run the seeding process
seedQuizzes();
