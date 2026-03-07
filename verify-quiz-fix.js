// Verify quiz loading end-to-end
const https = require('https');
const http = require('http');

const BASE_URL = process.env.APP_URL || 'https://stumped.polsia.app';

function fetch(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'StumpedVerifier/1.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
}

async function testQuiz(slug, topic) {
  console.log(`\n--- Testing quiz: ${topic} (slug: ${slug}) ---`);

  // Step 1: Fetch the quiz page HTML
  const pageRes = await fetch(`${BASE_URL}/quiz/${slug}`);
  console.log(`  Page HTML: ${pageRes.status} (${pageRes.body.length} bytes)`);

  if (pageRes.status !== 200) {
    console.log(`  ❌ FAIL: Quiz page returned ${pageRes.status}`);
    return false;
  }

  // Check for CSP headers that might block inline scripts
  const csp = pageRes.headers['content-security-policy'];
  if (csp) {
    console.log(`  ⚠️ CSP header found: ${csp}`);
    if (!csp.includes("'unsafe-inline'") && !csp.includes("'unsafe-eval'")) {
      console.log(`  ❌ FAIL: CSP blocks inline scripts!`);
    }
  }

  // Check the slug interpolation in the HTML
  const slugMatch = pageRes.body.match(/const slug = '([^']*)'/);
  if (slugMatch) {
    console.log(`  Slug in HTML: '${slugMatch[1]}'`);
    if (slugMatch[1] !== slug) {
      console.log(`  ❌ FAIL: Slug mismatch! Expected '${slug}', got '${slugMatch[1]}'`);
      return false;
    }
  } else {
    console.log(`  ❌ FAIL: Could not find slug variable in HTML`);
    return false;
  }

  // Check that loading screen has active class
  if (pageRes.body.includes('id="loading-screen" class="screen active"')) {
    console.log(`  Loading screen: starts active ✓`);
  } else {
    console.log(`  ⚠️ Loading screen may not start active`);
  }

  // Check that notfound screen does NOT have active class initially
  if (pageRes.body.includes('id="notfound-screen" class="screen"') && !pageRes.body.includes('id="notfound-screen" class="screen active"')) {
    console.log(`  Not-found screen: starts hidden ✓`);
  } else {
    console.log(`  ⚠️ Not-found screen state unexpected`);
  }

  // Check for JavaScript errors in the template (basic syntax check)
  const scriptMatch = pageRes.body.match(/<script>([\s\S]*?)<\/script>/g);
  if (scriptMatch) {
    console.log(`  Inline scripts: ${scriptMatch.length} found`);
  }

  // Check OG tags
  const ogTitle = pageRes.body.match(/<meta property="og:title" content="([^"]*)"/);
  if (ogTitle) {
    console.log(`  OG Title: ${ogTitle[1]}`);
  }

  // Step 2: Fetch the quiz API
  const apiRes = await fetch(`${BASE_URL}/api/quizzes/${slug}`);
  console.log(`  Quiz API: ${apiRes.status}`);

  if (apiRes.status !== 200) {
    console.log(`  ❌ FAIL: Quiz API returned ${apiRes.status}`);
    console.log(`  Response: ${apiRes.body.substring(0, 200)}`);
    return false;
  }

  try {
    const quiz = JSON.parse(apiRes.body);
    console.log(`  Quiz topic: ${quiz.topic}`);
    console.log(`  Questions: ${quiz.questions?.length}`);
    console.log(`  Players: ${quiz.playerCount}`);

    if (!quiz.questions || quiz.questions.length === 0) {
      console.log(`  ❌ FAIL: No questions in quiz!`);
      return false;
    }

    // Check question format matches what frontend expects
    const q = quiz.questions[0];
    if (!q.question || !q.options || !q.options.A || !q.options.B || !q.options.C || !q.options.D) {
      console.log(`  ❌ FAIL: Question format wrong. Got: ${JSON.stringify(q).substring(0, 200)}`);
      return false;
    }

    console.log(`  ✅ PASS: Quiz loads correctly`);
    return true;
  } catch (e) {
    console.log(`  ❌ FAIL: Could not parse API response: ${e.message}`);
    return false;
  }
}

async function testExploreLinks() {
  console.log('\n--- Testing Explore Feed ---');
  const res = await fetch(`${BASE_URL}/api/explore`);
  console.log(`  Explore API: ${res.status}`);

  if (res.status !== 200) {
    console.log(`  ❌ FAIL: Explore returned ${res.status}`);
    return;
  }

  const data = JSON.parse(res.body);
  console.log(`  Total quizzes: ${data.quizzes?.length}`);

  if (data.quizzes && data.quizzes.length > 0) {
    // Check URL format
    const first = data.quizzes[0];
    console.log(`  First quiz: "${first.topic}" url=${first.url}`);

    if (!first.url.startsWith('/quiz/')) {
      console.log(`  ❌ FAIL: URL format wrong: ${first.url}`);
    } else {
      console.log(`  URL format: correct ✓`);
    }

    // Test first 3 quizzes from explore
    let pass = 0;
    let fail = 0;
    for (let i = 0; i < Math.min(3, data.quizzes.length); i++) {
      const q = data.quizzes[i];
      const success = await testQuiz(q.slug, q.topic);
      if (success) pass++;
      else fail++;
    }

    console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
  }
}

async function testHomepage() {
  console.log('\n--- Testing Homepage ---');
  const res = await fetch(BASE_URL);
  console.log(`  Homepage: ${res.status} (${res.body.length} bytes)`);

  // Check if explore section loads
  if (res.body.includes('explore-grid') || res.body.includes('explore-section')) {
    console.log(`  Explore section: present ✓`);
  }

  // Check for any hardcoded quiz links
  const quizLinks = res.body.match(/\/quiz\/[a-zA-Z0-9-]+/g);
  if (quizLinks) {
    console.log(`  Hardcoded quiz links found: ${[...new Set(quizLinks)].join(', ')}`);
  } else {
    console.log(`  No hardcoded quiz links (dynamic via JS) ✓`);
  }
}

async function main() {
  console.log('=== Stumped Quiz Verification ===');
  console.log(`Testing: ${BASE_URL}`);
  console.log(`Time: ${new Date().toISOString()}`);

  try {
    await testHomepage();
    await testExploreLinks();

    // Also test the specific World Capitals quiz mentioned in the bug
    await testQuiz('42430324', 'World Capitals (original)');
    await testQuiz('63289b9d', 'World Capitals (latest)');
  } catch (err) {
    console.error('Verification failed:', err);
  }
}

main();
